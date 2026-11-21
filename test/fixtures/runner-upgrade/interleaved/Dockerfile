FROM alpine:3.24.3 AS runner-base
ARG VERSION
LABEL fixture.release=$VERSION
RUN mkdir -p /usr/local/bin \
  && touch "/usr/local/bin/runner-$VERSION" \
  && chmod +x "/usr/local/bin/runner-$VERSION"

FROM alpine:3.24.3 AS worker
ARG VERSION
LABEL fixture.release=$VERSION
USER 10001:10001
