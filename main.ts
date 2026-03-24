import { createServer } from "node:http";
import * as jose from "https://deno.land/x/jose@v5.9.6/index.ts";
import { WebSocketServer } from "npm:ws";
import type {
    WebSocket as WSWebSocket,
    WebSocketServer as _WebSocketServer,
} from "npm:@types/ws";
import { verifyHS256JWT } from "./utils.ts";
import {
    createFirstMessage,
    createSystemPrompt,
    getChatHistory,
    getSupabaseClient,
    getAdminSupabaseClient,
    getEmailByMacAddress,
    getUserByEmail,
} from "./supabase.ts";
import { SupabaseClient } from "@supabase/supabase-js";
import { isDev } from "./utils.ts";
import { connectToOpenAI } from "./models/openai.ts";
import { connectToGemini } from "./models/gemini.ts";
import { connectToElevenLabs } from "./models/elevenlabs.ts";
import { connectToHume } from "./models/hume.ts";
import { connectToGrok } from "./models/grok.ts";

const server = createServer(async (req, res) => {
    // ---------------------------------------------------------------------------
    // HTTP request handler (non-WebSocket).
    // The firmware hits GET /api/generate_auth_token?macAddress=<mac> on boot to
    // obtain a signed JWT it can then use as a Bearer token for the WS upgrade.
    // ---------------------------------------------------------------------------
    const url = new URL(req.url!, `http://${req.headers.host}`);

    if (url.pathname === "/api/generate_auth_token") {
        const mac = url.searchParams.get("macAddress");
        if (!mac) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "macAddress query param required" }));
            return;
        }
        try {
            const email = await getEmailByMacAddress(mac);
            if (!email) {
                res.writeHead(404, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Device not registered — add MAC in Supabase devices table" }));
                return;
            }
            const jwtSecret = Deno.env.get("JWT_SECRET_KEY");
            if (!jwtSecret) throw new Error("JWT_SECRET_KEY env var not set");

            const secretBytes = new TextEncoder().encode(jwtSecret);
            const token = await new jose.SignJWT({ email })
                .setProtectedHeader({ alg: "HS256" })
                .setExpirationTime("30d")
                .sign(secretBytes);

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ token }));
        } catch (e: any) {
            console.error("generate_auth_token error:", e);
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Internal server error", detail: e.message }));
        }
        return;
    }

    // Catch-all for any other HTTP path
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
});

const wss: _WebSocketServer = new WebSocketServer({ noServer: true,
    perMessageDeflate: false,
 });

wss.on('headers', (headers, req) => {
    // You should NOT see any "Sec-WebSocket-Extensions" here
    console.log('WS response headers :', headers);
});

// ---------------------------------------------------------------------------
// WebSocket connection handler — runs AFTER the handshake is complete.
// This is a proper async WebSocket context; Supabase fetches work fine here.
// ---------------------------------------------------------------------------
wss.on("connection", async (ws: WSWebSocket, payload: { email: string; deviceMac: string | undefined; timestamp: string }) => {
    const { email, deviceMac, timestamp } = payload;
    console.log(`WS connected: email=${email} deviceMac=${deviceMac}`);

    // Fetch user from Supabase now that we're in a WebSocket async context
    const supabase = getAdminSupabaseClient();
    let user: IUser;
    try {
        user = await getUserByEmail(supabase, email);
    } catch (err: any) {
        console.log("WS connection: getUserByEmail failed:", err.message);
        ws.close(1008, "User not found");
        return;
    }

    // MAC address check (only when a MAC is registered for this user's device)
    const expectedMac = user.device?.mac_address;
    if (!isDev && deviceMac && expectedMac && deviceMac !== expectedMac) {
        console.log(`WS connection: MAC mismatch — got ${deviceMac}, expected ${expectedMac}`);
        ws.close(1008, "MAC mismatch");
        return;
    }

    console.log(`WS connection: user=${user.email} ready, provider=${user.personality?.provider}`);

    const wsPayload: IPayload = { user, supabase, timestamp };

    let connectionPcmFile: Deno.FsFile | null = null;
    if (isDev) {
        const filename = `debug_audio_${Date.now()}.pcm`;
        connectionPcmFile = await Deno.open(filename, {
            create: true,
            write: true,
            append: true,
        });
    }

    const chatHistory = await getChatHistory(
        supabase,
        user.user_id,
        user.personality?.key ?? null,
        false,
    );
    const firstMessage = createFirstMessage(wsPayload);
    const systemPrompt = createSystemPrompt(chatHistory, wsPayload);

    const provider = user.personality?.provider;

    // send user details to client
    // when DEV_MODE is true, we send the default values 100, false, false
    ws.send(
        JSON.stringify({
            type: "auth",
            volume_control: user.device?.volume ?? 50,
            is_ota: user.device?.is_ota ?? false,
            is_reset: user.device?.is_reset ?? false,
            pitch_factor: user.personality?.pitch_factor ?? 1,
        }),
    );

    // Common close handler for cleanup
    const closeHandler = async () => {
        // Add any common cleanup logic here
    };

    // Common provider args
    const providerArgs: ProviderArgs = {
        ws,
        payload: wsPayload,
        connectionPcmFile,
        firstMessage,
        systemPrompt,
        closeHandler,
    };

    switch (provider) {
        case "openai":
            await connectToOpenAI(providerArgs);
            break;
        case "gemini":
            await connectToGemini(providerArgs);
            break;
        case "grok":
            await connectToGrok(providerArgs);
            break;
        case "elevenlabs":
            await connectToElevenLabs(providerArgs);
            break;
        case "hume":
            await connectToHume(providerArgs);
            break;
        default:
            throw new Error(`Unknown provider: ${provider}`);
    }
});

// ---------------------------------------------------------------------------
// HTTP upgrade → WebSocket handshake handler.
// IMPORTANT: Do NO async work here. Deno Deploy aborts pending async operations
// (fetch, SubtleCrypto, etc.) when the HTTP request transitions to a WebSocket.
// Only synchronous operations are safe. Supabase user fetch is deferred to the
// wss "connection" handler above which runs in a proper WebSocket async context.
// ---------------------------------------------------------------------------
server.on("upgrade", (req, socket, head) => {
    console.log('foobar upgrade', req.headers);
    try {
        const {
            authorization: authHeader,
            "x-wifi-rssi": rssi,
            "x-device-mac": deviceMac,
        } = req.headers;
        const authToken = authHeader?.replace("Bearer ", "") ?? "";
        const wifiStrength = parseInt(rssi as string);
        console.log("WiFi RSSI:", wifiStrength);

        if (!authToken) {
            socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
            socket.destroy();
            return;
        }

        const jwtSecret = Deno.env.get("JWT_SECRET_KEY");
        if (!jwtSecret) throw new Error("JWT_SECRET_KEY not configured");

        // Synchronous HMAC-SHA256 JWT verification — safe in upgrade handler
        const jwtPayload = verifyHS256JWT(authToken, jwtSecret);
        const email = jwtPayload.email as string;
        console.log(`WS upgrade: JWT OK email=${email} deviceMac=${deviceMac}`);

        // Immediately complete the WS handshake — no async ops before this point
        wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit("connection", ws, {
                email,
                deviceMac: deviceMac as string | undefined,
                timestamp: new Date().toISOString(),
            });
        });
    } catch (_e: any) {
        console.log("WS upgrade failed:", _e?.message ?? _e);
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
    }
});

if (isDev) { // RUN WITH: deno run -A --env-file=.env main.ts
    const HOST = Deno.env.get("HOST") || "0.0.0.0";
    const PORT = Deno.env.get("PORT") || "8000";
    server.listen(Number(PORT), HOST, () => {
        console.log(`Audio capture server running on ws://${HOST}:${PORT}`);
    });
} else {
    server.listen(8080);
}
