import { objectEntries } from '../object/entries'

/** -------------------- 类型 -------------------- */
/** Prompt 模板变量值 */
type PromptTemplateVariableValue = string | number

/** Prompt 模板变量集合 */
export type PromptTemplateVariables<T> = Record<
  Extract<keyof T, string>,
  PromptTemplateVariableValue
>

/** Prompt 模板变量名 */
export type PromptTemplateVariable<T> = Extract<keyof T, string>

/** Prompt 模板对象，命名和 format 行为对齐 LangChain PromptTemplate */
export interface PromptTemplate<T extends PromptTemplateVariables<T>> {
  /** 模板源码 */
  template: string
  /** 模板变量名列表 */
  inputVariables: Array<PromptTemplateVariable<T>>
  /** 填充模板变量并返回最终提示词 */
  format: (values: T) => string
}

/** -------------------- 核心函数 -------------------- */
/**
 * 创建可格式化的 Prompt 模板对象
 */
export function createPromptTemplate<T extends PromptTemplateVariables<T>>(input: {
  /** 模板源码 */
  template: string
  /** 模板变量名列表 */
  inputVariables: Array<PromptTemplateVariable<T>>
}): PromptTemplate<T> {
  return {
    template: input.template,
    inputVariables: input.inputVariables,
    format: values => objectEntries(values).reduce(
      (content, [name, value]) => content.replaceAll(`{{${name}}}`, String(value)),
      input.template,
    ),
  }
}
