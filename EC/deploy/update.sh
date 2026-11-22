#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
artifact=${1:?archive required}
stamp=${2:?timestamp required}
checksum=${3:?sha256 required}
registration=${4:-preserve}
[[ "$stamp" =~ ^[0-9]{8}-[0-9]{6}$ && "$checksum" =~ ^[a-f0-9]{64}$ ]] || exit 2
[[ "$registration" == preserve || "$registration" == enable ]] || exit 2
[[ "$artifact" == "/tmp/energy-calendar-$stamp.tar.gz" ]] || exit 2
echo "$checksum  $artifact" | sha256sum --check --status
stage="/opt/energy-calendar-staging-$stamp"
previous="/opt/energy-calendar-previous-$stamp"
backup="/var/backups/energy-calendar/$stamp"
[[ ! -e "$stage" && ! -e "$previous" && ! -e "$backup" ]] || exit 2
mkdir -p "$stage" "$backup"
tar -xzf "$artifact" -C "$stage" --no-same-owner
node=/usr/local/bin/node
version=$("$node" -p "require(process.argv[1]).version" "$stage/package.json")
"$node" --check "$stage/server/app.js"
"$node" --check "$stage/desktop/sync-storage.js"
replaced=0
started=0
configuration_changed=0
rollback() {
  trap - ERR
  set +e
  systemctl stop energy-calendar
  if [[ "$configuration_changed" == 1 ]]; then cp "$backup/service.env" /etc/energy-calendar.env; fi
  if [[ "$replaced" == 1 ]]; then
    [[ ! -e /opt/energy-calendar ]] || mv /opt/energy-calendar "/opt/energy-calendar-failed-$stamp"
    mv "$previous" /opt/energy-calendar
    if [[ "$started" == 1 ]]; then
      mv /var/lib/energy-calendar "/var/lib/energy-calendar-failed-$stamp"
      tar -xzf "$backup/data.tar.gz" -C /var/lib
    fi
  fi
  systemctl start energy-calendar
  echo "DEPLOYMENT_FAILED_ROLLED_BACK backup=$backup" >&2
  exit 1
}
trap rollback ERR
systemctl stop energy-calendar
tar -czf "$backup/data.tar.gz" -C /var/lib energy-calendar
tar -czf "$backup/program.tar.gz" -C /opt energy-calendar
cp /etc/energy-calendar.env "$backup/service.env"
"$node" "$stage/deploy/data-manifest.js" /var/lib/energy-calendar > "$backup/data-before.json"
mv /opt/energy-calendar "$previous"
replaced=1
mv "$stage" /opt/energy-calendar
chmod -R u+rwX,go+rX /opt/energy-calendar
if [[ "$registration" == enable ]]; then
  configuration_changed=1
  sed -i '/^CALENDAR_ALLOW_REGISTRATION=/d; /^CALENDAR_TRUST_PROXY=/d' /etc/energy-calendar.env
  printf '\nCALENDAR_ALLOW_REGISTRATION=true\nCALENDAR_TRUST_PROXY=true\n' >> /etc/energy-calendar.env
fi
started=1
systemctl start energy-calendar
for attempt in $(seq 1 20); do
  if curl --fail --silent http://127.0.0.1:3001/api/health > /dev/null; then break; fi
  sleep 0.5
done
curl --fail --silent http://127.0.0.1:3001/api/health
"$node" /opt/energy-calendar/deploy/verify-existing.js /var/lib/energy-calendar http://127.0.0.1:3001 "$backup/data-before.json"
if [[ "$registration" == enable ]]; then
  "$node" /opt/energy-calendar/deploy/verify-registration.js /var/lib/energy-calendar http://127.0.0.1:8000
fi
systemctl is-active --quiet energy-calendar
sha256sum "$backup/data.tar.gz" "$backup/program.tar.gz" > "$backup/SHA256SUMS"
trap - ERR
echo "DEPLOYMENT_OK version=$version backup=$backup previous=$previous"
