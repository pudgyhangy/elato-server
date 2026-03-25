import { Buffer } from "node:buffer";
import { createOpusPacketizer, geminiApiKey, isDev, defaultGeminiVoice } from "../utils.ts";

// Native audio dialog model for Gemini Developer API free tier (v1alpha endpoint required)
const GEMINI_MODEL = "models/gemini-2.5-flash-native-audio-preview-12-2025";

// The @google/genai SDK uses NodeWebSocketFactory → npm:ws internally.
// npm:ws never fires onopen in Deno Deploy's npm compat layer, causing
// ai.live.connect() to hang forever at `await onopenPromise`.
// Fix: use Deno's native global WebSocket and speak the wire protocol directly.
const geminiWsUrl = (apiKey: string) =>
    `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${apiKey}`;

export const connectToGemini = async ({
    ws,
    payload,
    connectionPcmFile,
    firstMessage,
    systemPrompt,
    closeHandler,
}: ProviderArgs) => {
    const { user } = payload;
    const voiceName = user.personality?.oai_voice ?? defaultGeminiVoice;
    const opus = createOpusPacketizer((packet) => ws.send(packet));
    console.log(`Connecting with Gemini key "${geminiApiKey?.slice(0, 3)}..."`);

    const responseQueue: any[] = [];
    let geminiWs: WebSocket | null = null;
    let geminiClosed = false;

    function waitMessage(): Promise<any> {
        return new Promise((resolve) => {
            const check = () => {
                if (geminiClosed) { resolve(null); return; }
                const msg = responseQueue.shift();
                if (msg !== undefined) { resolve(msg); return; }
                setTimeout(check, 10);
            };
            check();
        });
    }

    async function handleTurn() {
        const turns: any[] = [];
        let done = false;
        while (!done) {
            const message = await waitMessage();
            if (message === null) return turns; // WS closed, exit
            turns.push(message);
            if (message.serverContent?.generationComplete) {
                opus.reset();
                ws.send(JSON.stringify({ type: "server", msg: "RESPONSE.CREATED" }));
                done = true;
            }
        }
        return turns;
    }

    function extractAudio(turns: any[]): number[] {
        const samples: number[] = [];
        for (const turn of turns) {
            // Format A: top-level `data` field — confirmed working in bc3875d
            if (turn.data) {
                const buf = Buffer.from(turn.data, "base64");
                const arr = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
                samples.push(...Array.from(arr));
            }
            // Format B: serverContent.modelTurn.parts[x].inlineData.data — newer models
            for (const part of turn.serverContent?.modelTurn?.parts ?? []) {
                if (part.inlineData?.data) {
                    const buf = Buffer.from(part.inlineData.data, "base64");
                    const arr = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
                    samples.push(...Array.from(arr));
                }
            }
        }
        return samples;
    }

    async function processGeminiTurns() {
        console.log("Processing Gemini turns");
        try {
            while (!geminiClosed) {
                const turns = await handleTurn();
                if (geminiClosed) break;
                const samples = extractAudio(turns);
                if (samples.length > 0) {
                    const buf = Buffer.from(new Int16Array(samples).buffer);
                    opus.push(buf);
                    opus.flush(true);
                }
                ws.send(JSON.stringify({ type: "server", msg: "RESPONSE.COMPLETE" }));
            }
        } catch (error) {
            console.log("Error processing Gemini turns:", error);
        }
    }

    try {
        await new Promise<void>((resolve, reject) => {
            geminiWs = new WebSocket(geminiWsUrl(geminiApiKey!));

            geminiWs.onopen = () => {
                console.log("Gemini native WS opened");
                // Send setup message immediately after connection
                geminiWs!.send(JSON.stringify({
                    setup: {
                        model: GEMINI_MODEL,
                        generationConfig: {
                            responseModalities: ["AUDIO"],
                            speechConfig: {
                                voiceConfig: {
                                    prebuiltVoiceConfig: { voiceName },
                                },
                            },
                        },
                        systemInstruction: { parts: [{ text: systemPrompt }] },
                        realtimeInputConfig: {
                            automaticActivityDetection: {
                                disabled: false,
                                endOfSpeechSensitivity: "END_SENSITIVITY_LOW",
                                silenceDurationMs: 100,
                            },
                        },
                    },
                }));
                resolve();
            };

            geminiWs.onerror = (e: Event) => {
                console.log("Gemini native WS error:", JSON.stringify(e));
                reject(new Error("Gemini WebSocket error"));
            };

            geminiWs.onclose = (e: CloseEvent) => {
                console.log(`Gemini native WS closed: code=${e.code} reason=${e.reason}`);
                geminiClosed = true;
            };

            geminiWs.onmessage = async (event: MessageEvent) => {
                try {
                    // Deno's native WebSocket surfaces binary frames as Blob objects.
                    // Even though Gemini sends JSON, it uses binary WS frames — must decode first.
                    let text: string;
                    if (event.data instanceof Blob) {
                        text = await event.data.text();
                    } else if (event.data instanceof ArrayBuffer) {
                        text = new TextDecoder().decode(event.data);
                    } else {
                        text = event.data as string;
                    }
                    const msg = JSON.parse(text);
                    if (msg.setupComplete) {
                        console.log("Gemini setup complete — sending first message");
                        geminiWs!.send(JSON.stringify({
                            clientContent: {
                                turns: [{ role: "user", parts: [{ text: firstMessage }] }],
                                turnComplete: true,
                            },
                        }));
                    } else {
                        responseQueue.push(msg);
                    }
                } catch (err) {
                    console.log("Gemini WS parse error:", err);
                }
            };
        });

        console.log("Connected to Gemini successfully!");
        processGeminiTurns();

    } catch (e: unknown) {
        console.log(`Error connecting to Gemini: ${e}`);
        ws.close();
        return;
    }

    ws.on("message", (data: any, isBinary: boolean) => {
        try {
            if (isBinary && geminiWs?.readyState === 1 /* OPEN */) {
                if (isDev && connectionPcmFile) connectionPcmFile.write(data);
                geminiWs.send(JSON.stringify({
                    realtimeInput: {
                        audio: {
                            data: data.toString("base64"),
                            mimeType: "audio/pcm;rate=16000",
                        },
                    },
                }));
            }
        } catch (e: unknown) {
            console.log("Error handling message:", (e as Error).message);
        }
    });

    ws.on("error", (error: any) => {
        console.log("WebSocket error:", error);
        geminiClosed = true;
        geminiWs?.close();
    });

    ws.on("close", async (code: number, reason: string) => {
        console.log(`WebSocket closed with code ${code}, reason: ${reason}`);
        await closeHandler();
        opus.close();
        geminiClosed = true;
        geminiWs?.close();
        if (isDev && connectionPcmFile) {
            connectionPcmFile.close();
            console.log("Closed debug audio file.");
        }
    });
};
