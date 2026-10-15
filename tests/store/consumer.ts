/* eslint antfu/no-top-level-await: off -- 仓库外 Node.js 消费者顺序验收公开入口 */
import path from 'node:path'
import { createBlobStore, verifyBlobStore } from './support'

const blobs = createBlobStore(path.resolve('blobs'))
await verifyBlobStore(blobs)
