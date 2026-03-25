import { Buffer } from "node:buffer";
import type { WebSocketServer as _WebSocketServer } from "npm:@types/ws";
import {
    EndSensitivity,
    GoogleGenAI,
    LiveConnectConfig,
    LiveServerMessage,
    Modality,
    Session,
} from "npm:@google/genai";
import { createOpusPacketizer, geminiApiKey, isDev, defaultGeminiVoice } from "../utils.ts";
import { addConversation } from "../supabase.ts";
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
    console.log(`Connecting with Gemini key "${geminiApiKey?.slice(0, 3)}..."`);
    // Initialize Google GenAI
    const ai = new GoogleGenAI({ apiKey: geminiApiKey });
    const model = "gemini-2.5-flash-native-audio-preview-09-2025";
    const config: LiveConnectConfig = {
        responseModalities: [Modality.AUDIO],
        systemInstruction: systemPrompt,
        speechConfig: {
            voiceConfig: {
                prebuiltVoiceConfig: {
                    voiceName: voiceName,
                },
            },
        },
        realtimeInputConfig: {
            automaticActivityDetection: {
                disabled: false,
                endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_HIGH,
                silenceDurationMs: 100,
            },
        },
        outputAudioTranscription: {},
        inputAudioTranscription: {},
    };
    // Response queue for handling Google's callback-based responses
    const responseQueue: LiveServerMessage[] = [];
    let geminiSession: Session | null = null;

    async function waitMessage() {
        let done = false;
        let message: LiveServerMessage | undefined = undefined;
        while (!done) {
            if (!geminiSession) {
                return undefined;
            }
            message = responseQueue.shift();
            if (message) {
                done = true;
            } else {
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
        }
        return message;
    }

    // Streams audio to the device as each Gemini message arrives, rather than
    // collecting the entire response first. This reduces latency proportionally
    // to response length (first audio reaches device as soon as Gemini starts speaking).
    async function processGeminiTurns() {
        try {
            console.log("Processing Gemini turns");
            while (geminiSession) {
                let responseSent = false;
                let outputTranscriptionText = "";
                let inputTranscriptionText = "";
                let done = false;

                opus.reset(); // clear encoder state at start of each turn

                while (!done) {
                    const message = await waitMessage();
                    if (!geminiSession || !message) {
                        done = true;
                        break;
                    }

                    if (message.serverContent) {
                        // Stream audio to device as each chunk arrives from Gemini
                        if ((message as any).data) {
                            if (!responseSent) {
                                responseSent = true;
                                ws.send(JSON.stringify({
                                    type: "server",
                                    msg: "RESPONSE.CREATED",
                                }));
                            }
                            const buffer = Buffer.from((message as any).data, "base64");
                            const intArray = new Int16Array(
                                buffer.buffer,
                                buffer.byteOffset,
                                buffer.byteLength / Int16Array.BYTES_PER_ELEMENT,
                            );
                            opus.push(Buffer.from(new Int16Array(intArray).buffer));
                        }

                        if (message.serverContent.outputTranscription) {
                            outputTranscriptionText +=
                                message.serverContent.outputTranscription.text ?? "";
                        }
                        if (message.serverContent.inputTranscription) {
                            inputTranscriptionText +=
                                message.serverContent.inputTranscription.text ?? "";
                        }

                        if (
                            message.serverContent.generationComplete ||
                            message.serverContent.turnComplete
                        ) {
                            if (responseSent) opus.flush(true); // finalise any buffered Opus frames
                            ws.send(JSON.stringify({
                                type: "server",
                                msg: "RESPONSE.COMPLETE",
                            }));
                            done = true;
                        }
                    }
                }

                if (!geminiSession) break;

                await addConversation(supabase, "user", inputTranscriptionText, user);
                await addConversation(supabase, "assistant", outputTranscriptionText, user);
            }
        } catch (error) {
            console.log("Error processing Gemini turns:", error);
        }
    }

    // Connect to Google Gemini Live
    try {
        geminiSession = await ai.live.connect({
            model: model,
            callbacks: {
                onopen: function () {
                    console.log("Gemini session opened");
                },
                onmessage: function (message: LiveServerMessage) {
                    responseQueue.push(message);
                },
                onerror: function (e: any) {
                    // NOTE: was console.error (invisible on Deno Deploy) — now console.log
                    console.log("Gemini error:", e?.message ?? e);
                    if (ws.readyState === 1) ws.send(JSON.stringify({ type: "server", msg: "RESPONSE.ERROR" }));
                },
                onclose: function (e: any) {
                    console.log("Gemini session closed:", e?.reason ?? e?.code ?? "no reason");
                    geminiSession = null;
                    if (ws.readyState === 1 /* OPEN */) {
                        ws.close();
                    }
                },
            },
            config: config,
        });
        console.log("Connected to Gemini successfully!");
        const inputTurns = [{
            role: "user",
            parts: [{ text: firstMessage }],
        }];
        geminiSession?.sendClientContent({ turns: inputTurns });
        processGeminiTurns();
    } catch (e: unknown) {
        console.log(`Error connecting to Gemini: ${e}`);
        ws.close();
        return;
    }
    ws.on("message", (data: any, isBinary: boolean) => {
        try {
            if (isBinary) {
                const base64Data = data.toString("base64");
                if (isDev && connectionPcmFile) {
                    connectionPcmFile.write(data);
                }
                geminiSession?.sendRealtimeInput({
                    audio: {
                        data: base64Data,
                        mimeType: "audio/pcm;rate=16000",
                    },
                });
            }
        } catch (e: unknown) {
            console.log("Error handling message:", (e as Error).message);
        }
    });
    ws.on("error", (error: any) => {
        console.log("WebSocket error:", error);
        geminiSession?.close();
    });
    ws.on("close", async (code: number, reason: string) => {
        console.log(`WebSocket closed with code ${code}, reason: ${reason}`);
        await closeHandler();
        opus.close();
        geminiSession?.close();
        geminiSession = null;
        if (isDev && connectionPcmFile) {
            connectionPcmFile.close();
            console.log("Closed debug audio file.");
        }
    });
};
