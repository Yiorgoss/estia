// The node SQLite driver prepares a single statement at a time and Miniflare's
// D1 `exec()` mishandles multi-line statements, so each migration file is split
// into top-level statements before it is prepared. The splitter ignores
// semicolons inside string literals and inside a trigger's `BEGIN ... END`
// body.
export const splitStatements = (sql) => {
  const statements = []
  let buffer = ''
  let inSingle = false
  let inDouble = false
  let depth = 0
  let begins = 0
  let ends = 0
  const isWordChar = (char) => /[A-Za-z_]/.test(char)
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i]
    if (inSingle) {
      buffer += char
      if (char === "'") {
        if (sql[i + 1] === "'") buffer += sql[++i]
        else inSingle = false
      }
      continue
    }
    if (inDouble) {
      buffer += char
      if (char === '"') inDouble = false
      continue
    }
    if (char === "'") inSingle = true
    else if (char === '"') inDouble = true
    else if (char === '(') depth++
    else if (char === ')') depth--
    else if (isWordChar(char) && !isWordChar(sql[i - 1] ?? '')) {
      const match = /^(BEGIN|END)\b/i.exec(sql.slice(i))
      if (match) {
        if (match[1].toUpperCase() === 'BEGIN') begins++
        else ends++
      }
    }
    if (char === ';' && depth === 0 && begins <= ends) {
      const statement = buffer.trim()
      if (statement) statements.push(statement)
      buffer = ''
      continue
    }
    buffer += char
  }
  const tail = buffer.trim()
  if (tail) statements.push(tail)
  return statements
}
