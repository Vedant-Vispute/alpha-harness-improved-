/**
 * The Data Explorer's dataset filter as a tree: Category → Subcategory → Dataset. Pure, so the
 * picker only renders it; the choice itself is always a list of dataset ids.
 */

/** The facet lists the tree is built from (`CatalogFacets` fits). */
export interface TreeSource {
  categories: { id: string; name: string | null }[]
  subcategories: { id: string; name: string | null }[]
  datasets: {
    id: string
    category_id: string | null
    subcategory_id: string | null
  }[]
}

export interface Branch {
  /** Unique in the tree: the category and subcategory ids. */
  key: string
  id: string
  name: string
  /** Every dataset under this node. */
  ids: string[]
}

export interface Trunk extends Branch {
  subcategories: Branch[]
  /** Datasets without a subcategory. */
  loose: string[]
}

/**
 * Built from the datasets themselves, so every dataset sits exactly once under its own
 * category. Categories, subcategories and datasets keep the facets' order: largest first.
 */
export function buildTree(source: TreeSource): Trunk[] {
  const trunks = new Map<string, Trunk>()
  const trunkOf = (id: string | null, name?: string | null) => {
    const key = id ?? ''
    let trunk = trunks.get(key)
    if (!trunk) {
      trunk = {
        key,
        id: key,
        name: name ?? id ?? 'Uncategorised',
        ids: [],
        subcategories: [],
        loose: [],
      }
      trunks.set(key, trunk)
    }
    return trunk
  }
  for (const c of source.categories) trunkOf(c.id, c.name)
  const subcategoryName = new Map(source.subcategories.map((s) => [s.id, s.name]))
  const subcategoryRank = new Map(source.subcategories.map((s, i) => [s.id, i]))
  const branches = new Map<string, Branch>()
  for (const d of source.datasets) {
    const trunk = trunkOf(d.category_id)
    trunk.ids.push(d.id)
    if (!d.subcategory_id) {
      trunk.loose.push(d.id)
      continue
    }
    const key = `${trunk.key}|${d.subcategory_id}`
    let branch = branches.get(key)
    if (!branch) {
      branch = {
        key,
        id: d.subcategory_id,
        name: subcategoryName.get(d.subcategory_id) ?? d.subcategory_id,
        ids: [],
      }
      branches.set(key, branch)
      trunk.subcategories.push(branch)
    }
    branch.ids.push(d.id)
  }
  const rank = (b: Branch) => subcategoryRank.get(b.id) ?? Number.MAX_SAFE_INTEGER
  for (const trunk of trunks.values()) trunk.subcategories.sort((a, b) => rank(a) - rank(b))
  return [...trunks.values()].filter((t) => t.ids.length > 0)
}

/** One removable pick: a whole category, a whole subcategory, or a single dataset. */
export interface Ticked {
  key: string
  name: string
  ids: string[]
}

/** The picks under one subcategory, or under none for datasets that have no subcategory. */
export interface TickedBranch {
  key: string
  name: string | null
  /** The whole subcategory, when every dataset in it is ticked. */
  whole: Ticked | null
  datasets: Ticked[]
}

/** Everything ticked in one category, so a shared path is written once. */
export interface TickedTrunk {
  key: string
  /** Null for datasets the tree does not have: they still show, so they can be removed. */
  name: string | null
  /** The whole category, when every dataset in it is ticked. */
  whole: Ticked | null
  branches: TickedBranch[]
}

/**
 * What is ticked, grouped by where it sits: one entry per category, holding whole
 * subcategories and single datasets beneath it. A whole category is one pick.
 */
export function summarize(
  tree: Trunk[],
  value: string[],
  nameOf: (id: string) => string,
): TickedTrunk[] {
  const chosen = new Set(value)
  const covered = new Set<string>()
  const pick = (key: string, name: string, ids: string[]): Ticked => {
    for (const id of ids) covered.add(id)
    return { key, name, ids }
  }
  // A group of one is its dataset: naming the group would hide which dataset it is.
  const all = (ids: string[]) => ids.length > 1 && ids.every((id) => chosen.has(id))
  const datasets = (ids: string[]) =>
    ids.filter((id) => chosen.has(id)).map((id) => pick(`d:${id}`, nameOf(id), [id]))
  const summary: TickedTrunk[] = []
  for (const trunk of tree) {
    if (!trunk.ids.some((id) => chosen.has(id))) continue
    if (all(trunk.ids)) {
      summary.push({
        key: trunk.key,
        name: trunk.name,
        whole: pick(`c:${trunk.key}`, trunk.name, trunk.ids),
        branches: [],
      })
      continue
    }
    const branches: TickedBranch[] = []
    for (const branch of trunk.subcategories) {
      if (!branch.ids.some((id) => chosen.has(id))) continue
      const whole = all(branch.ids)
      branches.push({
        key: branch.key,
        name: branch.name,
        whole: whole ? pick(`s:${branch.key}`, branch.name, branch.ids) : null,
        datasets: whole ? [] : datasets(branch.ids),
      })
    }
    const loose = datasets(trunk.loose)
    if (loose.length)
      branches.push({ key: `${trunk.key}|`, name: null, whole: null, datasets: loose })
    summary.push({ key: trunk.key, name: trunk.name, whole: null, branches })
  }
  const unknown = value.filter((id) => !covered.has(id))
  if (unknown.length) {
    summary.push({
      key: 'unknown',
      name: null,
      whole: null,
      branches: [{ key: 'unknown|', name: null, whole: null, datasets: datasets(unknown) }],
    })
  }
  return summary
}

/**
 * Dataset ids to the names people read, each with its id: BRAIN gives some datasets the very
 * same name ("ETF Risk Data" is both model237 and risk82), and the id is also what a field's
 * prefix and every BRAIN page use.
 */
export function datasetNames(rows: { dataset_id: string; name: string | null }[]) {
  return new Map(
    rows.map((r) => [
      r.dataset_id,
      r.name && r.name !== r.dataset_id ? `${r.name} (${r.dataset_id})` : r.dataset_id,
    ]),
  )
}
