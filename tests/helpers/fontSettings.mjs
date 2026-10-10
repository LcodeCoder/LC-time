export const fakeFontSettings = () => {
  const overrides = new Map()
  const defaults = new Map()
  const key = ({ script = 'Zyyy', genericFamily }) => `${script}:${genericFamily}`
  return {
    overrides, defaults,
    getFontList: async () => ['Arial', 'Times New Roman', 'Menlo', 'Hiragino Sans', 'Hiragino Mincho ProN', 'PingFang SC', 'Songti SC'].map(fontId => ({ fontId, displayName: fontId })),
    getFont: async (details) => ({ fontId: overrides.get(key(details)) || defaults.get(key(details)) || 'Original font', levelOfControl: overrides.has(key(details)) ? 'controlled_by_this_extension' : 'controllable_by_this_extension' }),
    setFont: async (details) => { overrides.set(key(details), details.fontId) },
    clearFont: async (details) => { overrides.delete(key(details)) },
  }
}
