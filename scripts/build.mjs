import { mkdir, cp } from 'node:fs/promises'

await mkdir('build', { recursive: true })
for (const path of ['html', 'css', 'img', 'js', '_locales', 'manifest.json']) {
  await cp(path, `build/${path}`, { recursive: true })
}
console.log('LC-time extension built in build/')
