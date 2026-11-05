set -e

# tests run as bun, not root, so the cgroup tree is delegated to it
cg=/sys/fs/cgroup
chown bun:bun "$cg" "$cg/cgroup.procs" "$cg/cgroup.subtree_control" "$cg/cgroup.threads"

# a sandbox gets every address on eth0, so the test cluster's address sits on an interface of its own, off the pod's like a real one
ip link add cluster0 type dummy
ip addr add 10.250.0.1/32 dev cluster0
ip link set cluster0 up

cd /usr/src/app/harness
exec setpriv --reuid bun --regid bun --init-groups \
  env HOME=/home/bun TEST_DB_HOST=10.250.0.1 bun test --isolate "$@"
