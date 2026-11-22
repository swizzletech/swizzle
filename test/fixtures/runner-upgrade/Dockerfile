FROM node:26.12.1-trixie-slim AS runner-base
ARG VERSION
ARG SWIZZLE_DOCKER_TEST_RUN
LABEL fixture.release=$VERSION swizzle.test.run=$SWIZZLE_DOCKER_TEST_RUN
COPY infra/docker/runner-tools.mjs /tmp/runner-tools.mjs
RUN mkdir -p /etc/swizzle && node /tmp/runner-tools.mjs > /etc/swizzle/runner-tools.json
CMD ["true"]
FROM alpine:3.24.3 AS worker
ARG SWIZZLE_DOCKER_TEST_RUN
LABEL swizzle.test.run=$SWIZZLE_DOCKER_TEST_RUN
COPY --from=runner-base /etc/swizzle/runner-tools.json /etc/swizzle/runner-tools.json
USER 10001:10001
CMD ["tail", "-f", "/dev/null"]
FROM alpine:3.24.3 AS backup
ARG SWIZZLE_DOCKER_TEST_RUN
LABEL swizzle.test.run=$SWIZZLE_DOCKER_TEST_RUN
CMD ["true"]
