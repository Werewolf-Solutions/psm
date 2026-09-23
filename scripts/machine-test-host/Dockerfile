# A disposable stand-in for a customer server, for machine-onboarding tests.
# Ubuntu 20.04 matches the first real target (werewolf-alpha).
FROM ubuntu:20.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-server sudo ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /run/sshd /root/.ssh && chmod 700 /root/.ssh \
 && ssh-keygen -A \
 && sed -i 's/^#\?PasswordAuthentication .*/PasswordAuthentication no/' /etc/ssh/sshd_config \
 && useradd --create-home --shell /bin/bash --groups sudo admin-nopass \
 && useradd --create-home --shell /bin/bash --groups sudo admin-pass \
 && echo 'admin-pass:not-a-real-password' | chpasswd \
 && echo 'admin-nopass ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/admin-nopass \
 && chmod 440 /etc/sudoers.d/admin-nopass
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
EXPOSE 22
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
