# Container A: .NET SDK + Node 22 + Claude Agent SDK. Built once by `factory setup`.
ARG DOTNET_SDK=mcr.microsoft.com/dotnet/sdk:8.0
FROM ${DOTNET_SDK}
ARG NODE_MAJOR=22
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gnupg ripgrep \
 && curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && apt-get purge -y git || true \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/factory
COPY package.json run-agent.mjs ./
RUN npm install --omit=dev --no-audit --no-fund && chmod -R a+rX /opt/factory
ENV HOME=/tmp/home DOTNET_CLI_HOME=/tmp/home DOTNET_NOLOGO=1 DOTNET_CLI_TELEMETRY_OPTOUT=1 NUGET_PACKAGES=/nuget
ENTRYPOINT ["node", "/opt/factory/run-agent.mjs"]
