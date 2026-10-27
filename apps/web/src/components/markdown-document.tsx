import DOMPurify from "dompurify";
import { useEffect, useRef, useState } from "react";

import { ErrorNote, Skeleton } from "./ui";
import "./markdown-document.css";

type RenderedMarkdown = {
  readonly error: string | null;
  readonly html: string | null;
  readonly loading: boolean;
};

export function MarkdownDocument(props: {
  readonly available: boolean;
  readonly content: string | null;
  readonly error: string | null;
  readonly loading?: boolean;
}) {
  const documentRef = useRef<HTMLElement>(null);
  const [rendered, setRendered] = useState<RenderedMarkdown>({
    error: null,
    html: null,
    loading: false,
  });

  useEffect(() => {
    if (!props.available || !props.content) {
      setRendered({ error: null, html: null, loading: false });
      return;
    }

    let cancelled = false;
    setRendered({ error: null, html: null, loading: true });

    void import("marked")
      .then(({ marked }) =>
        // Any agent token can deploy a README. Without style, class and id it cannot position
        // itself over the dashboard or borrow the dashboard's own classes to look like its UI.
        DOMPurify.sanitize(marked.parse(props.content ?? "", { async: false, gfm: true }), {
          FORBID_ATTR: ["class", "id", "style"],
          FORBID_TAGS: ["audio", "form", "iframe", "img", "object", "style", "video"],
          USE_PROFILES: { html: true },
        }),
      )
      .then((html) => {
        if (!cancelled) {
          setRendered({ error: null, html, loading: false });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setRendered({
            error: error instanceof Error ? error.message : "README rendering failed.",
            html: null,
            loading: false,
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [props.available, props.content]);

  useEffect(() => {
    if (!documentRef.current) {
      return;
    }

    if (!rendered.html) {
      documentRef.current.replaceChildren();
      return;
    }

    const parsedDocument = new DOMParser().parseFromString(rendered.html, "text/html");
    documentRef.current.replaceChildren(
      ...Array.from(parsedDocument.body.childNodes, (node) => document.importNode(node, true)),
    );
  }, [rendered.html]);

  if (props.error || rendered.error) {
    return (
      <ErrorNote error={props.error ?? rendered.error} title="The README could not be shown." />
    );
  }

  if (props.loading || rendered.loading) return <Skeleton label="Loading the README" lines={5} />;

  if (!props.available || !props.content?.trim()) {
    return (
      <p className="t-meta">
        No README yet. Ask your agent to add a <span className="mono">README.md</span> to the
        automation folder that says what it does, what it needs and what it returns.
      </p>
    );
  }

  return (
    <article className="markdown-document" data-testid="automation-readme" ref={documentRef} />
  );
}
