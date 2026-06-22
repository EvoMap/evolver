#!/usr/bin/env bash
set -euo pipefail

settings_file=""
codex_config=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --settings)
      if [ "$#" -lt 2 ]; then
        echo "internal-proxy-env: missing value for --settings" >&2
        exit 2
      fi
      settings_file="$2"
      shift 2
      ;;
    --codex-config)
      codex_config=1
      shift
      ;;
    *)
      echo "internal-proxy-env: unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

node_bin="${NODE:-node}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
index_js="$repo_root/index.js"

url="$("$node_bin" -e '
const fs = require("fs");
const file = process.argv[1];
const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
const url = parsed && parsed.proxy && parsed.proxy.url;
if (typeof url !== "string" || !url.trim()) process.exit(1);
process.stdout.write(url.replace(/\/+$/, ""));
' "$settings_file")"

if [ "$codex_config" -eq 1 ]; then
  printf '[model_providers.evomap_proxy]\n'
  printf 'name = "EvoMap Proxy"\n'
  printf 'base_url = "%s/v1"\n' "$url"
  printf 'wire_api = "responses"\n'
  printf 'env_key = "ANTHROPIC_AUTH_TOKEN"\n'
  printf 'env_key_command = { command = %s, args = [%s, %s, %s] }\n' \
    "$(node -p 'JSON.stringify(process.execPath)')" \
    "$(node -p 'JSON.stringify(process.argv[1])' "$index_js")" \
    "$(node -p 'JSON.stringify("proxy-token")')" \
    "$(node -p 'JSON.stringify("--settings")'), $(node -p 'JSON.stringify(process.argv[1])' "$settings_file")"
  exit 0
fi

printf 'export ANTHROPIC_BASE_URL=%q\n' "$url/v1"
printf 'export ANTHROPIC_AUTH_TOKEN="$("%q" "%q" proxy-token --settings "%q")"\n' "$node_bin" "$index_js" "$settings_file"
