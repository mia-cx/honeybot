declare module 'heic-convert' {
  export default function heicConvert(options: {
    buffer: Buffer | Uint8Array | ArrayBuffer;
    format: 'JPEG' | 'PNG';
    quality?: number;
  }): Promise<Uint8Array | ArrayBuffer>;
}
