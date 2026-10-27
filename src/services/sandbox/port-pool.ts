export const portPool = (min: number, max: number) => {
  const taken = new Set<number>()

  return {
    take: () => {
      for (let port = min; port <= max; port++) {
        if (taken.has(port)) continue

        taken.add(port)

        return port
      }

      return null
    },

    release: (port: number) => {
      taken.delete(port)
    },
  }
}
