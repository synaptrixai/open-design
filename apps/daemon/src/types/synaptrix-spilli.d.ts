declare module '@synaptrix/spilli' {
  export function createSpilliService(keyPath: string): {
    getOrCreateSession(resource: { model: string; scope: string; team?: string }): {
      run(
        input: { prompt: string; query: string },
        options?: { onChunk?: (chunk: string) => void },
      ): Promise<string>;
    };
  };

  export function parseHarmonyOutput(raw: string): {
    isHarmony: boolean;
    messages?: Array<{
      recipient?: string;
      terminator?: string;
      content?: string;
    }>;
  };

  export function renderHarmonyForDisplay(raw: string): {
    display?: string;
  };
}
