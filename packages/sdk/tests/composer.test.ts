import { ThreadStateSchema } from '@elmino/protocol'
import { expect, test, vi } from 'vitest'
import { Composer } from '../src/composer'
import { createComposerThread } from './support/composer'

test('构造和读取不观察远端，纯空白阻断，结构化草稿隔离调用方修改', () => {
  // 创建绑定单个会话的本地草稿，初次读取不应取得网络观察权
  const data = createComposerThread()
  const composer = Composer.create({ thread: data.thread, input: '   ' })
  const snapshot = composer.getSnapshot()
  expect(composer.getSnapshot()).toBe(snapshot)
  expect(data.thread.subscribe).not.toHaveBeenCalled()
  expect(snapshot.canSubmit).toBe(false)
  // 引用和附件沿用领域输入，不把整个输入降级成字符串
  const input = [{ type: 'text' as const, text: '请查看' }, {
    type: 'image' as const,
    name: 'photo.png',
    mime: 'image/png' as const,
    data: 'YQ==',
    compress: false,
  }]
  composer.setInput(input)
  input[0]!.text = '调用方后续变更'
  expect(composer.getSnapshot().input[0]).toEqual({ type: 'text', text: '请查看' })
  expect(composer.getSnapshot().canSubmit).toBe(true)
})

test('接纳前保留草稿，迟到接纳不清空新草稿，返回原运行句柄', async () => {
  // 接纳和完成可以独立等待，提交不应一直等待模型执行结束
  const data = createComposerThread()
  const composer = Composer.create({ thread: data.thread, input: '第一条' })
  const submitting = composer.submit({ modelId: 'writer-model' })
  expect(composer.getSnapshot().submitting).toBe(true)
  expect(composer.getSnapshot().input).toEqual([{ type: 'text', text: '第一条' }])
  await expect(composer.submit()).resolves.toEqual({ status: 'blocked', reason: 'submitting' })
  composer.setInput('后来输入')
  data.runs[0]!.acceptance.resolve()
  await expect(submitting).resolves.toEqual({ status: 'submitted', run: data.runs[0]!.run })
  expect(data.start).toHaveBeenCalledWith([{ type: 'text', text: '第一条' }], { modelId: 'writer-model' })
  expect(composer.getSnapshot().input).toEqual([{ type: 'text', text: '后来输入' }])
  expect(composer.getSnapshot().submitting).toBe(false)
  data.finish()
})

test('接纳失败保留草稿并记录错误，不重发未知结果的输入', async () => {
  // 网络错误不能被当成服务端尚未接纳，更不能静默创建第二个 Turn
  const data = createComposerThread()
  const composer = Composer.create({ thread: data.thread, input: '保留正文' })
  const submitting = composer.submit()
  const error = new Error('acceptance unavailable')
  data.runs[0]!.acceptance.reject(error)
  data.runs[0]!.completion.reject(error)
  await expect(submitting).rejects.toBe(error)
  expect(composer.getSnapshot().error).toBe(error)
  expect(composer.getSnapshot().input).toEqual([{ type: 'text', text: '保留正文' }])
  expect(data.start).toHaveBeenCalledTimes(1)
})

test('运行中输入串行排队，接纳移除队首但原运行完成前不发送下一项', async () => {
  // 同一会话运行事实阻止本地队列同时提交多个 Turn
  const data = createComposerThread()
  data.update({ thread: data.state('running') })
  const composer = Composer.create({ thread: data.thread, input: '队列一' })
  await expect(composer.submit({ modelId: 'first' })).resolves.toMatchObject({ status: 'queued' })
  composer.setInput('队列二')
  await composer.submit({ modelId: 'second' })
  expect(data.start).not.toHaveBeenCalled()
  expect(data.listeners.size).toBe(1)
  data.update({ thread: data.state('completed') })
  expect(data.start).toHaveBeenCalledTimes(1)
  expect(composer.getSnapshot().queue[0]!.paused).toBe(true)
  data.runs[0]!.acceptance.resolve()
  await vi.waitFor(() => expect(composer.getSnapshot().queue).toHaveLength(1))
  expect(data.start).toHaveBeenCalledTimes(1)
  data.finish(0)
  await vi.waitFor(() => expect(data.start).toHaveBeenCalledTimes(2))
  expect(data.start.mock.calls[1]).toEqual([[{ type: 'text', text: '队列二' }], { modelId: 'second' }])
  data.runs[1]!.acceptance.resolve()
  await vi.waitFor(() => expect(composer.getSnapshot().queue).toHaveLength(0))
  expect(data.listeners.size).toBe(0)
  data.finish(1)
})

test('重连和待交互快照不发送队列，恢复校准后才继续', async () => {
  // 断线期间的旧快照不能作为空闲依据，待审批中断也不能被下一轮绕过
  const data = createComposerThread()
  data.update({ thread: data.state('running') })
  const composer = Composer.create({ thread: data.thread, input: '稍后发送' })
  await composer.submit()
  data.update({ status: 'reconnecting', thread: data.state('completed') })
  expect(data.start).not.toHaveBeenCalled()
  // 待审批事实通过正式 wire Schema，确保阻断来自同一 Turn 的真实归属
  const pending = ThreadStateSchema.parse(data.state('interrupted', true))
  data.update({ status: 'connected', thread: pending })
  expect(data.start).not.toHaveBeenCalled()
  composer.setInput('另一条')
  await expect(composer.submit()).resolves.toEqual({ status: 'blocked', reason: 'pendingInteraction' })
  data.update({ thread: data.state('completed') })
  expect(data.start).toHaveBeenCalledTimes(1)
  data.runs[0]!.acceptance.resolve()
  await vi.waitFor(() => expect(composer.getSnapshot().submitting).toBe(false))
  data.finish()
})

test('队列接纳未知时暂停且不自动重试，编辑后才明确重新提交', async () => {
  // 暂停的队首保留输入和顺序，不跳过失败项发送后续任务
  const data = createComposerThread()
  data.update({ thread: data.state('running') })
  const composer = Composer.create({ thread: data.thread, input: '未知接纳' })
  await composer.submit()
  data.update({ thread: data.state('completed') })
  const error = new Error('lost acknowledgement')
  data.runs[0]!.acceptance.reject(error)
  data.runs[0]!.completion.reject(error)
  await vi.waitFor(() => expect(composer.getSnapshot().error).toBe(error))
  data.update({ thread: data.state('completed') })
  expect(data.start).toHaveBeenCalledTimes(1)
  expect(composer.getSnapshot().queue[0]!.paused).toBe(true)
  expect(data.listeners.size).toBe(0)
  composer.editQueuedInput(composer.getSnapshot().queue[0]!.id)
  expect(composer.getSnapshot().input).toEqual([{ type: 'text', text: '未知接纳' }])
  expect(composer.getSnapshot().queue).toHaveLength(0)
  const resubmitting = composer.submit()
  data.runs[1]!.acceptance.resolve()
  await resubmitting
  data.finish(1)
})

test('异常运行终态暂停剩余队列，队列支持排序删除与回填', async () => {
  // 当前任务被停止后不应马上开始下一条排队任务
  const data = createComposerThread()
  const composer = Composer.create({ thread: data.thread, input: '当前任务' })
  const submitting = composer.submit()
  data.runs[0]!.acceptance.resolve()
  await submitting
  composer.setInput('排队一')
  await composer.submit()
  composer.setInput('排队二')
  await composer.submit()
  composer.moveQueuedInput(1, 0)
  expect(composer.getSnapshot().queue[0]!.input).toEqual([{ type: 'text', text: '排队二' }])
  data.finish(0, 'interrupted')
  await vi.waitFor(() => expect(composer.getSnapshot().queue.every(item => item.paused)).toBe(true))
  expect(data.start).toHaveBeenCalledTimes(1)
  composer.removeQueuedInput(composer.getSnapshot().queue[1]!.id)
  composer.editQueuedInput(composer.getSnapshot().queue[0]!.id)
  expect(composer.getSnapshot().input).toEqual([{ type: 'text', text: '排队二' }])
  expect(data.listeners.size).toBe(0)
})

test('最后一个视图卸载释放订阅，dispose只停止本地调度且可重复调用', async () => {
  // 视图与队列共同借用一个会话订阅，释放 Composer 不停止远端任务
  const data = createComposerThread()
  const composer = Composer.create({ thread: data.thread, input: '正文' })
  const listener = vi.fn()
  const unsubscribe = composer.subscribe(listener)
  expect(data.listeners.size).toBe(1)
  unsubscribe()
  expect(data.listeners.size).toBe(0)
  data.update({ thread: data.state('running') })
  await composer.submit()
  expect(data.listeners.size).toBe(1)
  composer.dispose()
  composer.dispose()
  data.update({ thread: data.state('completed') })
  expect(data.listeners.size).toBe(0)
  expect(data.start).not.toHaveBeenCalled()
  expect(composer.getSnapshot().canSubmit).toBe(false)
  await expect(composer.submit()).resolves.toEqual({ status: 'blocked', reason: 'closed' })
})

test('同步首次会话通知期间关闭Composer，迟到返回的订阅仍被释放', () => {
  // 真实会话可以在 subscribe 内同步发布连接或交互校准，关闭不能泄漏尚未返回的释放函数
  const data = createComposerThread()
  const composer = Composer.create({ thread: data.thread, input: '正文' })
  vi.spyOn(data.thread, 'subscribe').mockImplementation((listener) => {
    data.listeners.add(listener)
    data.update({ thread: data.state('interrupted', true) })
    return () => data.listeners.delete(listener)
  })
  composer.subscribe(() => composer.dispose())
  expect(data.listeners.size).toBe(0)
  expect(data.start).not.toHaveBeenCalled()
  expect(composer.getSnapshot().canSubmit).toBe(false)
})

test('发送提示触发同步关闭时不再创建远端任务，原草稿仍保留', async () => {
  // 观察者可能响应提交状态结束当前会话视图，发送前必须重新检查关闭边界
  const data = createComposerThread()
  const composer = Composer.create({ thread: data.thread, input: '关闭前草稿' })
  composer.subscribe(() => {
    if (composer.getSnapshot().submitting)
      composer.dispose()
  })
  await expect(composer.submit()).rejects.toThrow('Composer 已关闭')
  expect(data.start).not.toHaveBeenCalled()
  expect(data.listeners.size).toBe(0)
  expect(composer.getSnapshot().input).toEqual([{ type: 'text', text: '关闭前草稿' }])
})

test('观察者异常不改变提交接纳，也不阻止其他观察者读取新草稿', async () => {
  // 草稿投影的展示异常不能伪装成远端提交失败，导致调用方重复发送
  const data = createComposerThread()
  const composer = Composer.create({ thread: data.thread, input: '正文' })
  const error = new Error('view failed')
  const listener = vi.fn()
  composer.subscribe(() => {
    throw error
  })
  composer.subscribe(listener)
  const submitting = composer.submit()
  data.runs[0]!.acceptance.resolve()
  await expect(submitting).resolves.toMatchObject({ status: 'submitted' })
  expect(data.start).toHaveBeenCalledTimes(1)
  expect(composer.getSnapshot().input).toHaveLength(0)
  expect(composer.getSnapshot().error).toBe(error)
  expect(listener).toHaveBeenCalled()
  data.finish()
  composer.dispose()
})
