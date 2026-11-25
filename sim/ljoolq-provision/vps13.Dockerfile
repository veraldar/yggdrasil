# The G4.6 rehearsal box: a throwaway Debian 13 "VPS" with systemd as PID 1 (sim/ljoolq-provision-e2e.sh).
# Like veraldar: Debian 13, systemd, ufw on, and a dockerd that leaves FORWARD at DROP. Not like it: no AppArmor
# (the home kernel runs none), the home kernel, docker's /dev (a snapshot: loop nodes are made at boot), and
# systemd-detect-virt says container (lxcfs is told to run anyway, as it does on the VPS's KVM).
FROM debian:13
ENV container=docker
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      systemd systemd-sysv dbus ca-certificates curl iproute2 procps ufw iptables python3 kmod \
 && rm -rf /var/lib/apt/lists/* /usr/sbin/policy-rc.d \
 && systemctl mask getty@tty1.service console-getty.service systemd-firstboot.service systemd-udevd.service \
      systemd-modules-load.service
COPY docker-standin.service /etc/systemd/system/docker.service
COPY loop-nodes.service /etc/systemd/system/loop-nodes.service
COPY lxcfs-in-box.conf /etc/systemd/system/lxcfs.service.d/rehearsal.conf
RUN systemctl enable docker.service loop-nodes.service
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
