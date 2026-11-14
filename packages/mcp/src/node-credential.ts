/**
 * 子ごとの資格情報の入れ物（紐付けと購読で共有する）。mcp のプロセスの中だけに持つ（ファイル・環境変数・ログに出さない）。
 *
 * - 紐付けの道具（`child_bind`）が成功したら `set`。失効（daemon の 401）が分かったら `clear` で空にする。
 * - `onChange`: 値が変わるたびに呼ぶ（`/v1/events` の購読は、値が入ったら始め、空になったら止める）。外す関数を返す。
 * - 根の統合セッション（紐付けを使わない）は、この入れ物を使わない（根のトークンのまま）。
 */

export interface NodeCredential {
  readonly nodeId: string;
  readonly token: string;
}

export interface NodeCredentialStore {
  get(): NodeCredential | undefined;
  set(c: NodeCredential): void;
  clear(): void;
  onChange(fn: (c: NodeCredential | undefined) => void): () => void;
}

export function createNodeCredentialStore(): NodeCredentialStore {
  let current: NodeCredential | undefined;
  const listeners = new Set<(c: NodeCredential | undefined) => void>();
  const emit = (): void => {
    for (const fn of listeners) {
      try {
        fn(current);
      } catch {
        // 受け手の失敗で、入れ物を変えない
      }
    }
  };
  return {
    get: () => current,
    set(c) {
      current = Object.freeze({ nodeId: c.nodeId, token: c.token });
      emit();
    },
    clear() {
      if (current === undefined) return;
      current = undefined;
      emit();
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
