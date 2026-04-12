/**
 * UI locale mirrors Obsidian **Settings → About → Language** via the same storage key
 * the app uses (`language` in localStorage). Russian → `ru`; everything else → English.
 */
export type PluginLocale = "en" | "ru";

const messages = {
	en: {
		basesViewName: "Structure",
		settingsDescription:
			"This plugin currently uses per-view settings in the bases view.",
		renameTitle: "Rename",
		renameCancel: "Cancel",
		renameSubmit: "Rename",
		renameEmptyName: "Enter a file name.",
		renameFileExists: "A file with this name already exists.",
		emptyNoEntries: "No entries found.",
		emptyNoRoots: "No roots found. Check for cyclic relations.",
		emptyNoMatch: 'No notes match "{q}".',
		expandAll: "Expand all",
		expandAllAria: "Expand all branches",
		collapseAll: "Collapse all",
		collapseAllAria: "Collapse all branches",
		showActiveFile: "Show active file",
		showActiveFileAria:
			"Expand path to active note, scroll to it; repeat to cycle duplicate rows",
		filterPlaceholder: "Filter tree…",
		filterAria: "Filter tree by name",
		clearFilterAria: "Clear filter",
		noticeNoActiveNote: "No active note.",
		noticeNothingToShow: "Nothing to show in this view.",
		noticeActiveNotInBase: "Active note is not in this base.",
		noticeActiveHiddenFilter: "Active note is hidden by the current filter.",
		noticeOccurrenceHiddenFilter:
			"This occurrence is hidden by the current filter.",
		menuRename: "Rename",
		menuDeleteFile: "Delete file",
		menuCreateSubNote: "Create sub-note",
		toggleBranchAria: "Expand or collapse branch",
		spineCollapseAria: "Collapse branch",
		newNoteBaseName: "New note",
		noticeCycle: "This operation would create a cycle.",
		couldNotCreateSubNote: "Could not create sub-note: {detail}",
		couldNotSaveRelation:
			'Could not save relation for "{name}": {detail}',
		viewOptionRelationProperty: "Relation property",
		viewOptionRelationPlaceholder: "up",
		viewOptionSubNoteTemplate: "Sub-note template",
		viewOptionSubNotePlaceholder: "Template from Templater folder",
		tplNotInstalled:
			"Templater is not installed or does not expose write_template_to_file.",
		tplTemplateNotFound: "Template file not found: {path}",
		tplTemplaterFailed: "Templater: {msg}",
	},
	ru: {
		basesViewName: "Структура",
		settingsDescription:
			"Сейчас плагин использует настройки отдельно для каждого вида Bases.",
		renameTitle: "Переименовать",
		renameCancel: "Отмена",
		renameSubmit: "Переименовать",
		renameEmptyName: "Введите имя файла.",
		renameFileExists: "Файл с таким именем уже существует.",
		emptyNoEntries: "Записей не найдено.",
		emptyNoRoots: "Корней не найдено. Проверьте циклические связи.",
		emptyNoMatch: 'Нет заметок по запросу «{q}».',
		expandAll: "Развернуть всё",
		expandAllAria: "Развернуть все ветки",
		collapseAll: "Свернуть всё",
		collapseAllAria: "Свернуть все ветки",
		showActiveFile: "Показать активный файл",
		showActiveFileAria:
			"Развернуть путь к активной заметке и прокрутить к ней; повтор — следующий дубликат строки",
		filterPlaceholder: "Фильтр дерева…",
		filterAria: "Фильтр дерева по имени",
		clearFilterAria: "Сбросить фильтр",
		noticeNoActiveNote: "Нет активной заметки.",
		noticeNothingToShow: "В этом виде нечего показать.",
		noticeActiveNotInBase: "Активная заметка не входит в эту базу.",
		noticeActiveHiddenFilter:
			"Активная заметка скрыта текущим фильтром.",
		noticeOccurrenceHiddenFilter:
			"Эта строка скрыта текущим фильтром.",
		menuRename: "Переименовать",
		menuDeleteFile: "Удалить файл",
		menuCreateSubNote: "Создать подзаметку",
		toggleBranchAria: "Развернуть или свернуть ветку",
		spineCollapseAria: "Свернуть ветку",
		newNoteBaseName: "Новая заметка",
		noticeCycle: "Эта операция создаст цикл.",
		couldNotCreateSubNote: "Не удалось создать подзаметку: {detail}",
		couldNotSaveRelation:
			'Не удалось сохранить связь для «{name}»: {detail}',
		viewOptionRelationProperty: "Свойство связи",
		viewOptionRelationPlaceholder: "up",
		viewOptionSubNoteTemplate: "Шаблон подзаметки",
		viewOptionSubNotePlaceholder: "Шаблон из папки Templater",
		tplNotInstalled:
			"Templater не установлен или не предоставляет write_template_to_file.",
		tplTemplateNotFound: "Файл шаблона не найден: {path}",
		tplTemplaterFailed: "Templater: {msg}",
	},
} as const;

export type MessageKey = keyof typeof messages.en;

export function getPluginLocale(): PluginLocale {
	try {
		if (typeof localStorage !== "undefined" && localStorage.getItem("language") === "ru") {
			return "ru";
		}
	} catch {
		/* ignore (e.g. storage unavailable) */
	}
	return "en";
}

export function t(locale: PluginLocale, key: MessageKey, vars?: Record<string, string>): string {
	let template = messages[locale][key] as string;
	if (vars) {
		for (const [k, v] of Object.entries(vars)) {
			template = template.split(`{${k}}`).join(v);
		}
	}
	return template;
}
