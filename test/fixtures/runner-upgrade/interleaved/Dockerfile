FROM alpine:3.24.3 AS runner-base
ARG VERSION
ARG SWIZZLE_DOCKER_TEST_RUN
LABEL fixture.release=$VERSION swizzle.test.run=$SWIZZLE_DOCKER_TEST_RUN
RUN mkdir -p /usr/local/bin \
  && touch "/usr/local/bin/runner-$VERSION" \
  && chmod +x "/usr/local/bin/runner-$VERSION"

FROM alpine:3.24.3 AS worker
ARG VERSION
ARG SWIZZLE_DOCKER_TEST_RUN
LABEL fixture.release=$VERSION swizzle.test.run=$SWIZZLE_DOCKER_TEST_RUN
USER 10001:10001
