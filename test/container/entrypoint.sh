set -e

# tests run as bun, not root, so the cgroup tree is delegated to it
cg=/sys/fs/cgroup
chown bun:bun "$cg" "$cg/cgroup.procs" "$cg/cgroup.subtree_control" "$cg/cgroup.threads"

# a sandbox shares the container's own IP, so the test database needs an address of its own
ip addr add 10.250.0.1/32 dev eth0

cd /usr/src/app
exec setpriv --reuid bun --regid bun --init-groups \
  env HOME=/home/bun TEST_DB_HOST=10.250.0.1 bun test --isolate "$@"
