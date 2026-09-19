// Phase 2 swaps this for a Vonage session + two tokens. Same signature.
export async function createVideoCall(ticketId: string): Promise<{ url: string }> {
  return { url: `https://example.com/call/${encodeURIComponent(ticketId)}` };
}
