/** Save `text` as a file named `filename`, the way a link with `download` would. */
export function saveText(filename: string, text: string, type = 'text/markdown') {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }))
  const link = Object.assign(document.createElement('a'), { href: url, download: filename })
  // In the page for the click: some engines ignore a click on a detached link.
  link.hidden = true
  document.body.append(link)
  link.click()
  link.remove()
  // Later, not at once: revoking while the browser still reads the file can fail the download.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
