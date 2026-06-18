export interface ParsedToolResponse {
  parts: any[];
  functionCalls: { name: string; args: any }[];
  text: string;
}

/** Extract function calls and/or text from a Gemini generateContent response. */
export function parseGeminiToolResponse(responseData: any): ParsedToolResponse {
  const parts: any[] = responseData?.candidates?.[0]?.content?.parts ?? [];
  const functionCalls = parts
    .filter((p) => p && p.functionCall)
    .map((p) => ({ name: p.functionCall.name as string, args: p.functionCall.args ?? {} }));
  const text = parts
    .filter((p) => p && typeof p.text === "string")
    .map((p) => p.text)
    .join("");
  return { parts, functionCalls, text };
}
