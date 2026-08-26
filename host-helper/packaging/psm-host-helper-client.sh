#!/bin/sh
set -eu

if [ "$#" -ne 0 ]; then
  echo "psm-host-helper-client: arguments are not accepted" >&2
  exit 64
fi

exec /usr/local/libexec/psm-host-helper client
