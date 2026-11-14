/**
 * 手元の開発のビルド（`pnpm build`）かどうか。配布物（`scripts/dist-build.sh` の tar.gz）では、ビルドのときに
 * この行を `false` に書き換える（書き換えられなければ配布物を作らない）。
 *
 * `false` のとき、試験用の抜け道（`TOURYOU_CLI_ALLOW_UNVERIFIED`）は効かない（`docs/cli.md`）。
 */
export const DEV_BUILD: boolean = true;
