import { createServer } from "node:http";
import * as jose from "https://deno.land/x/jose@v5.9.6/index.ts";
import { WebSocketServer } from "npm:ws";
import type {
    WebSocket as WSWebSocket,
    WebSocketServer as _WebSocketServer,
} from "npm:@types/ws";
import { authenticateUser } from "./utils.ts";
import {
    createFirstMessage,
    createSystemPrompt,
    getChatHistory,
    getSupabaseClient,
    getAdminSupabaseClient,
    getEmailByMacAddress,
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

wss.on("connection", async (ws: WSWebSocket, payload: IPayload) => {
    const { user, supabase } = payload;

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
    const firstMessage = createFirstMessage(payload);
    const systemPrompt = createSystemPrompt(chatHistory, payload);

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
        payload,
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

server.on("upgrade", async (req, socket, head) => {
    console.log('foobar upgrade', req.headers);
    let user: IUser;
    let supabase: SupabaseClient;
    let authToken: string;
    try {
        const {
            authorization: authHeader,
            "x-wifi-rssi": rssi,
            "x-device-mac": deviceMac,
        } = req.headers;
        authToken = authHeader?.replace("Bearer ", "") ?? "";
        const wifiStrength = parseInt(rssi as string); // Convert to number

        // You can now use wifiStrength in your code
        console.log("WiFi RSSI:", wifiStrength); // Will log something like -50

        // Remove debug logging
        if (!authToken) {
            socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
            socket.destroy();
            return;
        }

        // Use admin client — the custom JWT (signed with JWT_SECRET_KEY) is not a
        // valid Supabase Auth token, so using it with PostgREST would fail.
        // Admin client uses SUPABASE_KEY (service role) to bypass RLS.
        supabase = getAdminSupabaseClient();
        user = await authenticateUser(supabase, authToken as string);

        if (!user) {
            throw new Error("User not found for token email");
        }

        // MAC address check: only enforce when the user has a device with a MAC registered.
        // If device_id isn't set in users table yet, expectedMac is undefined → skip check.
        const expectedMac = user.device?.mac_address;
        console.log(`WS upgrade: user=${user.email} deviceMac=${deviceMac} expectedMac=${expectedMac} isDev=${isDev}`);
        if (!isDev && deviceMac && expectedMac && deviceMac !== expectedMac) {
            console.log(`WS upgrade: MAC mismatch — got ${deviceMac}, expected ${expectedMac}`);
            socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
            socket.destroy();
            return;
        }
    } catch (_e: any) {
        console.log("WS upgrade auth failed:", _e?.message ?? _e);
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, {
            user,
            supabase,
            timestamp: new Date().toISOString(),
        });
    });
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
