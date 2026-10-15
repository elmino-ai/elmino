import { runExample } from './app/run'

runExample().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
