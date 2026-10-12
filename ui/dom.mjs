export function clearChildren(element) {
  if (!element) return;
  while (element.firstChild) element.removeChild(element.firstChild);
}
