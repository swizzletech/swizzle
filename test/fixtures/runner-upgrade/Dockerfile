FROM node:26.12.1-trixie-slim AS runner-base
ARG VERSION
LABEL fixture.release=$VERSION
COPY infra/docker/runner-tools.mjs /tmp/runner-tools.mjs
RUN mkdir -p /etc/swizzle && node /tmp/runner-tools.mjs > /etc/swizzle/runner-tools.json
CMD ["true"]
FROM node:26.12.1-alpine3.24 AS worker
COPY --from=runner-base /etc/swizzle/runner-tools.json /etc/swizzle/runner-tools.json
USER 10001:10001
CMD ["tail", "-f", "/dev/null"]
FROM node:26.12.1-alpine3.24 AS api
ARG VERSION
ENV RELEASE_VERSION=$VERSION
CMD ["node", "--input-type=module", "-e", "import {createServer} from 'node:http'; createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'ok',version:process.env.RELEASE_VERSION}));}).listen(19820,'0.0.0.0');"]
FROM node:26.12.1-alpine3.24 AS backup
CMD ["true"]
