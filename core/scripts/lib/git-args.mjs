// git-args.mjs — разбор командной строки git для guard-скриптов.
//
// Вынесено в отдельный модуль, потому что от точности этого разбора зависит,
// сработают ли git-гарды вообще: если «подкоманда» определена неверно, ни один
// запрет (push --force, push в основную ветку, удаление ветки) не найдёт, к
// чему прицепиться, и опасная команда пройдёт как разрешённая.
//
// Историческая причина: прежний разбор пропускал любой `-`-флаг, но НЕ съедал
// ЗНАЧЕНИЕ пробельных опций. `git --git-dir /r/.git push --force origin main`
// давал «подкоманду» /r/.git — и force-push проходил. Настоящий git такую
// форму принимает.
//
// Экспортирует:
//   joinContinuations(command)  — склеивает `\` + перенос строки
//   gitSubcommand(rest)         — подкоманда, с учётом value-опций
//   gitArgs(rest)               — аргументы подкоманды (без глобальных опций)
//   normalizeRefspec(spec)      — `+main`, `HEAD:refs/heads/main` -> `main`

// Глобальные опции git, ЗАБИРАЮЩИЕ значение следующим токеном. Пропустить
// значение обязательно: иначе оно будет принято за подкоманду.
// `--` тоже принимает значение в форме `--opt=value`, её обрабатываем отдельно.
export const GIT_VALUE_OPTS = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
  '--config-env',
  '--super-prefix',
]);

// Продолжение строки (`\` в конце) — это ОДНА команда, а не две. Прежний
// разбор резал ввод по `\n` раньше склейки, поэтому
// `git \`⏎`push --force` разъезжалось на «git» и «push --force», и ни одна
// половина под git-гарды не попадала.
export function joinContinuations(command) {
  return String(command).replace(/\\\r?\n[ \t]*/g, ' ');
}

// Индекс первого токена, который не является глобальной опцией git.
function firstNonOption(rest) {
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (t === '--') return i + 1 < rest.length ? i + 1 : -1;
    if (GIT_VALUE_OPTS.has(t)) {
      i++; // съедаем значение
      continue;
    }
    if (t.startsWith('-')) continue; // флаг без значения либо `--opt=value`
    return i;
  }
  return -1;
}

// Подкоманда git (push / checkout / …) либо null.
export function gitSubcommand(rest) {
  const i = firstNonOption(rest);
  return i === -1 ? null : rest[i];
}

// Аргументы ПОДКОМАНДЫ: всё после неё. Глобальные опции git и их значения
// сюда не попадают — иначе путь из `--git-dir <path>` можно принять за имя
// ветки в `push origin <branch>`.
export function gitArgs(rest) {
  const i = firstNonOption(rest);
  return i === -1 ? [] : rest.slice(i + 1);
}

// Приведение refspec к имени ветки назначения.
// `+main` — форс-пуш в main (плюс = force для этого refspec).
// `HEAD:refs/heads/main`, `src:dst` — целевая ветка справа от двоеточия.
// Возвращает { branch, forced }.
export function normalizeRefspec(spec) {
  if (typeof spec !== 'string' || !spec) return { branch: null, forced: false };
  let s = spec;
  let forced = false;
  if (s.startsWith('+')) {
    forced = true;
    s = s.slice(1);
  }
  const colon = s.lastIndexOf(':');
  if (colon !== -1) s = s.slice(colon + 1);
  s = s.replace(/^refs\/heads\//, '');
  return { branch: s || null, forced };
}
