#!/bin/sh
set -eu

if [ -z "${SWIZZLE_EGRESS_PROXY:-}" ]; then
  exec "$@"
fi

case "$SWIZZLE_EGRESS_PROXY" in
  *:*) ;;
  *)
    echo "SWIZZLE_EGRESS_PROXY must use host:port format" >&2
    exit 64
    ;;
esac

proxy_host=${SWIZZLE_EGRESS_PROXY%:*}
proxy_port=${SWIZZLE_EGRESS_PROXY##*:}
config_path=/tmp/swizzle-proxychains.conf

proxy_ip=$(getent ahostsv4 "$proxy_host" | awk 'NR == 1 { print $1 }')
if [ -z "$proxy_ip" ]; then
  echo "Unable to resolve the configured Swizzle egress proxy" >&2
  exit 69
fi

umask 077
{
  echo "strict_chain"
  echo "proxy_dns"
  echo "remote_dns_subnet 224"
  echo "tcp_read_time_out 15000"
  echo "tcp_connect_time_out 8000"
  echo "[ProxyList]"
  printf 'http %s %s\n' "$proxy_ip" "$proxy_port"
} > "$config_path"

exec proxychains4 -q -f "$config_path" "$@"
