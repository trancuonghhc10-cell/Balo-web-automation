/**
 * Process Spintax {A|B|C} recursively
 * Example: "{Chào bạn|Xin chào|Hello} {anh|chị} [name]!"
 */
function processSpintax(text) {
  if (!text) return '';
  const regex = /\{([^{}]+)\}/g;
  while (regex.test(text)) {
    text = text.replace(regex, (match, choices) => {
      const parts = choices.split('|');
      return parts[Math.floor(Math.random() * parts.length)];
    });
  }
  return text;
}

/**
 * Replace placeholders like [name], [phone], etc.
 */
function replacePlaceholders(template, contact = {}) {
  let result = template;
  result = result.replace(/\[name\]/gi, contact.name || 'bạn');
  result = result.replace(/\[zalo_name\]/gi, contact.zalo_name || contact.name || 'bạn');
  result = result.replace(/\[phone\]/gi, contact.phone || '');
  return result;
}

function renderMessage(template, contact = {}) {
  const withPlaceholders = replacePlaceholders(template, contact);
  return processSpintax(withPlaceholders);
}

module.exports = {
  processSpintax,
  replacePlaceholders,
  renderMessage
};
