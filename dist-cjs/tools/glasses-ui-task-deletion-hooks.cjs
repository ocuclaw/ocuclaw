function findLiveuiTasksReferencingTemplate(taskLibrary, templateId) {
  const references = [];
  if (!taskLibrary || typeof taskLibrary.listItems !== "function" ||
      typeof taskLibrary.read !== "function") return references;
  const listed = taskLibrary.listItems();
  for (const row of (listed && listed.items) || []) {
    if (!row || row.itemType !== "task" || row.status === "invalid") continue;
    const loaded = taskLibrary.read(row.itemId);
    if (loaded && loaded.status === "accepted" && loaded.task &&
        loaded.task.preferredTemplateId === templateId) {
      references.push({ taskId: row.itemId, digest: loaded.task.digest });
    }
  }
  return references;
}

function createLiveuiTaskDeletionHookRegistry(opts = {}) {
  const runRecordsHook = typeof opts.runRecordsOnTaskDeleted === "function"
    ? opts.runRecordsOnTaskDeleted
    : () => undefined;
  const secretsHook = typeof opts.secretsOnTaskDeleted === "function"
    ? opts.secretsOnTaskDeleted
    : () => undefined;

  return {
    onTaskDeleted(taskId, details = {}) {
      const preferredTemplateId = typeof details.preferredTemplateId === "string"
        ? details.preferredTemplateId
        : null;
      const referencedTemplateIds = preferredTemplateId ? [preferredTemplateId] : [];
      runRecordsHook(taskId);
      secretsHook(taskId);
      if (
        preferredTemplateId &&
        typeof opts.readTemplate === "function" &&
        typeof opts.loadOrganization === "function" &&
        typeof opts.taskLibrary === "function" &&
        typeof opts.deleteHelperTemplate === "function"
      ) {
        try {
          const loaded = opts.readTemplate(preferredTemplateId);
          const template = loaded && loaded.status === "accepted" ? loaded.template : null;
          const organizationState = opts.loadOrganization();
          const hidden = organizationState && organizationState.organization &&
            Array.isArray(organizationState.organization.hidden) &&
            organizationState.organization.hidden.includes(`template:${preferredTemplateId}`);
          const shared = findLiveuiTasksReferencingTemplate(
            opts.taskLibrary(),
            preferredTemplateId,
          );
          if (
            template && template.helperOf && template.helperOf.taskId === taskId &&
            hidden && shared.length === 0
          ) {
            opts.deleteHelperTemplate(preferredTemplateId, template.digest);
          }
        } catch (_) {

        }
      }
      return { referencedTemplateIds };
    },
  };
}

module.exports = { findLiveuiTasksReferencingTemplate, createLiveuiTaskDeletionHookRegistry };
