#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'HELP'
Usage: HOMELAB_SSH_TARGET=user@host bash scripts/deploy-homelab.sh --deploy

Build committed HEAD for linux/amd64 and push to GHCR. Update only the app
image in homelab GitOps, then apply that manifest over SSH and wait for health.
Set HOMELAB_SSH_TARGET to an SSH destination (user@host or a configured alias).
HELP
}

fail() { printf '%s\n' "$*" >&2; exit 1; }

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
  --deploy) [[ $# == 1 ]] || fail 'Expected only --deploy.' ;;
  *) usage >&2; exit 2 ;;
esac

cd "$(dirname "$0")/.."
for tool in docker gh git jq ssh; do
  command -v "$tool" >/dev/null || fail "Missing required command: $tool"
done

image=ghcr.io/dongnv0502/yan-zalo-web
manifest=apps/yan-zalo-web/compose.yml
endpoint="repos/dongnv0502/homelab/contents/$manifest"
ssh_target=${HOMELAB_SSH_TARGET:?Set HOMELAB_SSH_TARGET to the production SSH destination.}
revision=$(git rev-parse HEAD)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# Archive the exact commit: uncommitted files, local .env and data stay out.
printf 'Building committed HEAD %s for linux/amd64\n' "$revision"
git archive "$revision" | docker buildx build --platform linux/amd64 --push \
  --tag "$image:local-$revision" --metadata-file "$tmp/build.json" \
  --label "org.opencontainers.image.revision=$revision" \
  --label 'org.opencontainers.image.source=https://github.com/dongnv0502/yan-zalo-web' -
digest=$(jq -er '."containerimage.digest"' "$tmp/build.json")
[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || fail 'Buildx did not return a valid registry digest.'

# The file SHA prevents overwriting a concurrent change to this manifest.
gh api --method GET "$endpoint" -f ref=main > "$tmp/file.json"
blob=$(jq -er '.sha' "$tmp/file.json")
jq -jer '.content | gsub("\\s"; "") | @base64d' "$tmp/file.json" > "$tmp/current.yml"
pattern='^    image: ghcr\.io/dongnv0502/yan-zalo-web@sha256:[0-9a-f]{64}$'
awk -v pattern="$pattern" -v image="$image@$digest" '
  $0 ~ pattern { $0 = "    image: " image; matches++ }
  { print }
  END { if (matches != 1) exit 1 }
' "$tmp/current.yml" > "$tmp/next.yml" || fail 'Expected exactly one digest-pinned YAN Zalo image in homelab Compose.'

if ! cmp -s "$tmp/current.yml" "$tmp/next.yml"; then
  payload=$(jq -n --arg sha "$blob" --arg message "deploy(yan-zalo-web): ${revision:0:12} (local)" \
    --rawfile manifest "$tmp/next.yml" \
    '{sha: $sha, message: $message, branch: "main", content: ($manifest | @base64)}')
  gh api --method PUT "$endpoint" --input - <<< "$payload" > "$tmp/update.json"
  printf 'GitOps commit: %s\n' "$(jq -er '.commit.sha' "$tmp/update.json")"
  blob=$(jq -er '.content.sha' "$tmp/update.json")
fi
[[ "$blob" =~ ^[0-9a-f]{40}$ ]] || fail 'GitHub did not return a valid manifest blob SHA.'

# Share the cron runner lock, but do not move its checkout HEAD: cron still
# needs to apply any pending changes to other stacks.
ssh -o BatchMode=yes -o ConnectTimeout=10 -- "$ssh_target" bash -s -- "$blob" "$digest" <<'REMOTE'
set -euo pipefail
expected_blob=$1
expected_image=ghcr.io/dongnv0502/yan-zalo-web@$2
cd "$HOME/homelab"
exec 9>/tmp/homelab-deploy.lock
flock -w 120 9
manifest=apps/yan-zalo-web/compose.yml
git fetch -q origin main
if [[ $(git rev-parse "FETCH_HEAD:$manifest") != "$expected_blob" ]]; then
  echo 'The GitOps manifest changed during deploy; refusing to apply a stale release.' >&2
  exit 1
fi
compose_yaml=$(git show "FETCH_HEAD:$manifest")
cd "${manifest%/*}"
docker compose --project-directory "$PWD" -f - up -d --no-deps --no-build --pull missing \
  --wait --wait-timeout 120 yan-zalo-web <<< "$compose_yaml"
[[ $(docker inspect --format '{{.Config.Image}}' yan-zalo-web) == "$expected_image" ]]
REMOTE
printf 'Healthy: %s@%s\n' "$image" "$digest"
