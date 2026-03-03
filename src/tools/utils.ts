export function textContent(text: string) {
  return {
    content: [
      {
        type: 'text' as const,
        text,
      },
    ],
  };
}

export function toPrettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
