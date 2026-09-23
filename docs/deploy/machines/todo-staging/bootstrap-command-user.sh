#!/usr/bin/env bash
# Bootstrap draft for werewolf-alpha. Defaults to a read-only preflight.
set -euo pipefail

mode=${1:---check}
key_file=${2:-}
if [[ $# -ne 2 || ( "$mode" != --check && "$mode" != --apply ) ]]; then
  echo "usage: bash bootstrap-command-user.sh --check|--apply PUBLIC_KEY_FILE" >&2
  exit 64
fi
fail() { echo "bootstrap: $*" >&2; exit 1; }
[[ $(hostname) == werewolf-alpha ]] || fail "expected host werewolf-alpha"
[[ -f "$key_file" && ! -L "$key_file" ]] || fail "provide a regular public-key file"

# Only the public half of a dedicated Ed25519 key is accepted.
key_line=$(cat -- "$key_file")
[[ "$key_line" != *$'\n'* ]] || fail "expected exactly one public key"
read -r key_type key_data key_comment <<< "$key_line"
[[ "$key_type" == ssh-ed25519 && "$key_data" =~ ^[A-Za-z0-9+/]+={0,2}$ ]] || fail "expected an Ed25519 public key"
fingerprint=$(ssh-keygen -lf "$key_file" -E sha256) || fail "invalid public key"
authorized="restrict $key_type $key_data psm-exec-todo-staging"

account=psm-exec-todo-staging
account_home=/home/psm-exec-todo-staging
workspace=/srv/psm/commands/todo-staging
account_comment='PSM command account: todo-staging'

# Root-owned parents prevent the command account from replacing its key policy.
root_directory() {
  local directory=$1
  [[ ! -L "$directory" ]] || fail "symlink rejected: $directory"
  if [[ -e "$directory" ]]; then
    [[ -d "$directory" && $(stat -c %u "$directory") == 0 ]] || fail "expected root-owned directory: $directory"
    local permissions
    permissions=$(stat -c %a "$directory")
    (( (8#$permissions & 0022) == 0 )) || fail "directory is writable by group/others: $directory"
  fi
}

inspect() {
  local directory row password uid gid comment home shell
  for directory in /home /srv /srv/psm /srv/psm/commands "$account_home" "$account_home/.ssh"; do
    root_directory "$directory"
  done
  [[ ! -L "$workspace" ]] || fail "workspace symlink rejected"
  [[ ! -L "$account_home/.ssh/authorized_keys" ]] || fail "authorized_keys symlink rejected"
  if row=$(getent passwd "$account"); then
    IFS=: read -r _ password uid gid comment home shell <<< "$row"
    [[ "$uid" != 0 && "$home" == "$account_home" && "$shell" == /bin/bash && "$comment" == "$account_comment" ]] || fail "existing account differs from this bootstrap"
    [[ $(id -gn "$account") == "$account" && $(id -G "$account") == "$gid" ]] || fail "existing account has unexpected groups"
    if [[ -e "$workspace" ]]; then
      [[ -d "$workspace" && $(stat -c %u "$workspace") == "$uid" && $(stat -c %g "$workspace") == "$gid" ]] || fail "workspace ownership differs"
    fi
  else
    ! getent group "$account" >/dev/null || fail "group already exists without the expected account"
    [[ ! -e "$account_home" && ! -e "$workspace" ]] || fail "account paths already exist without the expected account"
  fi
  if [[ -e "$account_home/.ssh/authorized_keys" ]]; then
    [[ -f "$account_home/.ssh/authorized_keys" && $(stat -c %u "$account_home/.ssh/authorized_keys") == 0 ]] || fail "unexpected authorized_keys ownership/type"
    [[ $(cat "$account_home/.ssh/authorized_keys") == "$authorized" ]] || fail "existing SSH key differs; use an explicit key rotation"
  fi
}

if [[ "$mode" == --apply ]]; then
  [[ $EUID == 0 ]] || fail "apply requires administrator authentication through sudo"
  # Serialize bootstrap runs. No account-owned path is used for the lock.
  exec 9>/run/lock/psm-exec-todo-staging-bootstrap.lock
  flock -n 9 || fail "another bootstrap is running"
fi
inspect
printf '%s\n' "Host: $(hostname)" "Account: $account" "Public key: $fingerprint" \
  "Commands workspace: $workspace" \
  'Authority: ordinary Unix commands; no sudo or deployment-helper group added.' \
  'SSH key: command execution allowed; forwarding and PTY disabled.' \
  'Existing infrastructure/release users, app services and SSH daemon configuration are preserved.'

if [[ "$mode" == --check ]]; then
  echo 'Read-only preflight passed. No changes made.'
  exit 0
fi

if ! getent passwd "$account" >/dev/null; then
  useradd --user-group --no-create-home --home-dir "$account_home" \
    --shell /bin/bash --password '!' --comment "$account_comment" "$account"
fi
install -d -o root -g root -m 0755 /srv/psm /srv/psm/commands
install -d -o root -g "$account" -m 0750 "$account_home" "$account_home/.ssh"
install -d -o "$account" -g "$account" -m 0700 "$workspace"

# Never replace an existing key. A partial installation can be resumed.
if [[ ! -e "$account_home/.ssh/authorized_keys" ]]; then
  temporary=$(mktemp "$account_home/.ssh/.authorized_keys.XXXXXX")
  trap 'rm -f -- "${temporary:-}"' EXIT
  printf '%s\n' "$authorized" > "$temporary"
  chown root:"$account" "$temporary"
  chmod 0640 "$temporary"
  mv -- "$temporary" "$account_home/.ssh/authorized_keys"
  trap - EXIT
fi
inspect
id "$account"
echo 'Account prepared. Verify key authentication and command execution from the PSM machine.'
