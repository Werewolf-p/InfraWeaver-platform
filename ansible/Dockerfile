FROM python:3.12-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    ANSIBLE_FORCE_COLOR=1 \
    ANSIBLE_HOST_KEY_CHECKING=False

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      openssh-client \
      sshpass && \
    pip install --no-cache-dir "ansible-core~=2.17.0" && \
    ansible-galaxy collection install ansible.posix community.crypto && \
    rm -rf /var/lib/apt/lists/* && \
    mkdir -p /root/.ssh && \
    chmod 700 /root/.ssh

WORKDIR /ansible
