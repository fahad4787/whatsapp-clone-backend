declare module "archiver" {
  import type { Transform } from "node:stream";

  export class Archiver extends Transform {
    append(
      source: string | NodeJS.ReadableStream | Buffer,
      data: { name: string },
    ): this;
    finalize(): Promise<void>;
  }

  export class ZipArchive extends Archiver {
    constructor(options?: { zlib?: { level?: number } });
  }
}
