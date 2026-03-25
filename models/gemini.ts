import { Buffer } from "node:buffer";
import type { WebSocketServer as _WebSocketServer } from "npm:@types/ws";
import { createOpusPacketizer, geminiApiKey, isDev, defaultGeminiVoice } from "../utils.ts";
import { addConversation } from "../supabase.ts";

// NOTE: We use native Deno WebSocket instead of npm:@google/genai because
// the SDK's ai.live.connect() hangs forever in Deno Deploy's npm compat layer
// regardless of SDK version. Native WebSocket is first-class in Deno Deploy.
const GEMINI_LIVE_WS = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

export const connectToGemini = async ({
    ws,
    payload,
    connectionPcmFile,
    firstMessage,
    systemPrompt,
    closeHandler,
}: ProviderArgs) => {
    const { user, supabase } = payload;
    const voiceName = user.personality?.oai_voice ?? defaultGeminiVoice;
    const opus = createOpusPacketizer((packet) => ws.send(packet));
    const model = "gemini-2.5-flash-native-audio-preview-12-2025";

    console.log(`Connecting with Gemini key "${geminiApiKey?.slice(0, 3)}..." (native WS, model=${model})`);

    const responseQueue: any[] = [];
    let geminiWs: WebSocket | null = null;

    async function waitMessage(): Promise<any | undefined> {
        while (true) {
            if (!geminiWs || geminiWs.readyState !== 1 /* OPEN */) return undefined;
            const msg = responseQueue.shift();
            if (msg) return msg;
            await new Promise((r) => setTimeout(r, 10));
        }
    }

    // Streams audio to the device as each Gemini message arrives.
    async function processGeminiTurns() {
        try {
            console.log("Processing Gemini turns");
            while (geminiWs && geminiWs.readyState === 1) {
                let responseSent = false;
                let done = false;
                opus.reset();

                while (!done) {
                    const msg = await waitMessage();
                    if (!geminiWs || !msg) { done = true; break; }

                    const sc = msg.serverContent;
                    if (sc) {
                        // Extract audio from modelTurn parts
                        const parts: any[] = sc.modelTurn?.parts ?? [];
                        for (const part of parts) {
                            if (part.inlineData?.data) {
                                if (!responseSent) {
                                    responseSent = true;
                                    ws.send(JSON.stringify({ type: "server", msg: "RESPONSE.CREATED" }));
                                }
                                const buf = Buffer.from(part.inlineData.data, "base64");
                                opus.push(Buffer.from(
                                    new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2).buffer
                                ));
                            }
                        }
                        if (sc.generationComplete || sc.turnComplete) {
                            if (responseSent) opus.flush(true);
                            ws.send(JSON.stringify({ type: "server", msg: "RESPONSE.COMPLETE" }));
                            done = true;
                        }
                    }
                }

                if (!geminiWs || geminiWs.readyState !== 1) break;
            }
        } catch (e) {
            console.log("Error in processGeminiTurns:", e);
        }
    }

    // ── Connect to Gemini Live API via native Deno WebSocket ──────────────────
    try {
        geminiWs = new WebSocket(`${GEMINI_LIVE_WS}?key=${geminiApiKey}`);

        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() =>
                reject(new Error("Gemini WS setup timed out (10s) — check API key / model access")), 10_000
            );

            geminiWs!.onopen = () => {
                console.log("Gemini WS: opened — sending setup");
                geminiWs!.send(JSON.stringify({
                    setup: {
                        model: `models/${model}`,
                        generationConfig: {
                            responseModalities: ["AUDIO"],
                            speechConfig: {
                                voiceConfig: {
                                    prebuiltVoiceConfig: { voiceName },
                                },
                            },
                        },
                        systemInstruction: {
                            parts: [{ text: systemPrompt }],
                        },
                        realtimeInputConfig: {
                            automaticActivityDetection: {
                                disabled: false,
                                endOfSpeechSensitivity: "END_SENSITIVITY_HIGH",
                                silenceDurationMs: 100,
                            },
                        },
                    },
                }));
            };

            geminiWs!.onmessage = (event) => {
                try {
                    const parsed = JSON.parse(event.data as string);
                    if ("setupComplete" in parsed) {
                        console.log("Gemini WS: setupComplete received — session ready");
                        clearTimeout(timeout);
                        // Switch to normal message handler
                        geminiWs!.onmessage = (ev) => {
                            try { responseQueue.push(JSON.parse(ev.data as string)); } catch { /* ignore */ }
                        };
                        resolve();
                    } else {
                        // Unexpected pre-setup message — log and ignore
                        console.log("Gemini WS: unexpected pre-setup message:", JSON.stringify(parsed).slice(0, 200));
                    }
                } catch (e) {
                    console.log("Gemini WS: failed to parse setup message:", e);
                }
            };

            geminiWs!.onerror = (e) => {
                clearTimeout(timeout);
                console.log("Gemini WS: error during setup:", e);
                reject(new Error("Gemini WS error during setup"));
            };

            (geminiWs as any).onclose = (e: any) => {
                clearTimeout(timeout);
                const code = e?.code ?? "?";
                const reason = e?.reason ?? "";
                console.log(`Gemini WS: closed during setup — code=${code} reason="${reason}"`);
                reject(new Error(`Gemini WS closed during setup: code=${code} reason="${reason}"`));
            };
        });

        // ── Setup complete — replace close handler for runtime ────────────────
        (geminiWs as any).onclose = (e: any) => {
            const code = e?.code ?? "?";
            const reason = e?.reason ?? "";
            console.log(`Gemini session closed: code=${code} reason="${reason}"`);
            geminiWs = null;
            if (ws.readyState === 1 /* OPEN */) ws.close();
        };

        console.log("Connected to Gemini Live successfully!");

        // Send opening text turn
        geminiWs.send(JSON.stringify({
            clientContent: {
                turns: [{ role: "user", parts: [{ text: firstMessage }] }],
                turnComplete: true,
            },
        }));
        processGeminiTurns();

    } catch (e: unknown) {
        console.log(`Error connecting to Gemini: ${e}`);
        ws.close();
        return;
    }
    // ─────────────────────────────────────────────────────────────────────────

    ws.on("message", (data: any, isBinary: boolean) => {
        try {
            if (isBinary) {
                const base64Data = data.toString("base64");
                if (isDev && connectionPcmFile) connectionPcmFile.write(data);
                if (geminiWs && geminiWs.readyState === 1) {
                    geminiWs.send(JSON.stringify({
                        realtimeInput: {
                            audio: { data: base64Data, mimeType: "audio/pcm;rate=16000" },
                        },
                    }));
                }
            }
        } catch (e: unknown) {
            console.log("Error handling message:", (e as Error).message);
        }
    });

    ws.on("error", (error: any) => {
        console.log("WebSocket error:", error);
        geminiWs?.close();
    });

    ws.on("close", async (code: number, reason: string) => {
        console.log(`WebSocket closed with code ${code}, reason: ${reason}`);
        await closeHandler();
        opus.close();
        geminiWs?.close();
        geminiWs = null;
        if (isDev && connectionPcmFile) {
            connectionPcmFile.close();
            console.log("Closed debug audio file.");
        }
    });
};
