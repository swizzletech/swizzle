import full from "./logo-full.svg";
import head from "./logo-head.svg";

export function Logo(props: { readonly className?: string; readonly compactOnPhone?: boolean }) {
  const image = <img alt="Swizzle" className={`logo ${props.className ?? ""}`} src={full} />;
  return props.compactOnPhone ? (
    <picture>
      <source media="(max-width: 420px)" srcSet={head} />
      {image}
    </picture>
  ) : (
    image
  );
}
