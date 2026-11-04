// A PMTiles source that copes with hosts that ignore HTTP Range requests
// (Cloudflare Pages sends the whole file). If a range request comes back as the
// full file, keep that file and cut every later range out of it. The offline
// cache downloads the whole file anyway, so this costs nothing extra.
import type { RangeResponse, Source } from "pmtiles";

export class RangeOrWholeSource implements Source {
  private whole?: Promise<Blob>;
  private readonly url: string;
  constructor(url: string) {
    this.url = url;
  }
  getKey() {
    return this.url;
  }
  async getBytes(offset: number, length: number, signal?: AbortSignal): Promise<RangeResponse> {
    if (!this.whole) {
      const res = await fetch(this.url, { headers: { range: `bytes=${offset}-${offset + length - 1}` }, signal });
      if (res.status === 206) return { data: await res.arrayBuffer() };
      if (!res.ok) throw new Error(`basemap: HTTP ${res.status}`);
      // A full file: this one download serves every tile from now on.
      const whole = res.blob();
      this.whole ??= whole;
      // If that download fails (aborted, offline), try again next time.
      whole.catch(() => {
        if (this.whole === whole) this.whole = undefined;
      });
    }
    const blob = await this.whole;
    return { data: await blob.slice(offset, offset + length).arrayBuffer() };
  }
}
