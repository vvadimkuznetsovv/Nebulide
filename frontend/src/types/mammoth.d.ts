declare module 'mammoth' {
  interface ConvertResult {
    value: string;
    messages: Array<{ type: string; message: string }>;
  }

  interface ConvertOptions {
    arrayBuffer: ArrayBuffer;
  }

  export function convertToHtml(options: ConvertOptions): Promise<ConvertResult>;
}
