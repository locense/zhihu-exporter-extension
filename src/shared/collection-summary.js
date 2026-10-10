export function toPublicCollection(collection) {
  return {
    id: collection?.id || '',
    url: collection?.url || (collection?.id ? `https://www.zhihu.com/collection/${collection.id}` : ''),
    title: collection?.title || `收藏夹-${collection?.id || ''}`,
    count: collection?.count ?? null,
    visibility: collection?.visibility || 'unknown',
    description: collection?.description || '',
    listType: collection?.listType || 'unknown'
  };
}

export function isPlaceholderCollectionTitle(title, id) {
  const value = String(title || '').trim();
  return !value || value === `收藏夹-${id || ''}` || /^收藏夹-\d+$/.test(value);
}
