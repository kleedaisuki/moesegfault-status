/** 官方 CSS 品牌标记的原生 DOM 适配，不携带身份信息。 / Native DOM adapter for the official CSS brand contract; contains no identity data. */
export function brandMark(): HTMLElement {
  const brand = document.createElement("div");
  brand.className = "moe-brand-mark";
  const symbol = document.createElement("span");
  symbol.className = "moe-brand-mark__symbol";
  symbol.setAttribute("aria-hidden", "true");
  symbol.textContent = "M";
  const text = document.createElement("div");
  text.className = "moe-brand-mark__text";
  const title = document.createElement("span");
  title.className = "moe-brand-mark__name";
  title.textContent = "MoeSegfault Status";
  const tagline = document.createElement("span");
  tagline.className = "moe-brand-mark__tagline";
  tagline.textContent = "运维控制台 / Operations";
  text.append(title, tagline);
  brand.append(symbol, text);
  return brand;
}
