import { basename, join } from "node:path";

/**
 * 試験で待つソケットの場所。POSIX ではディレクトリの中の s.sock。
 * Windows ではファイルのパスで待てないので、ディレクトリの名前から作った名前付きパイプにする。
 */
export const sockPath = (dir: string): string =>
  process.platform === "win32" ? `\\\\.\\pipe\\${basename(dir)}` : join(dir, "s.sock");
