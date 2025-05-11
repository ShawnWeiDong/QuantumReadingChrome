// 监听来自background.js的消息
chrome.runtime.onMessage.addListener(
  function(request, sender, sendResponse) {
    if (request.action === "extractContent") {
      extractAndShowContent();
      // 返回true表示将异步发送响应
      return true;
    }
  }
);

// 监听自定义事件，以防消息传递失败
document.addEventListener('WEBPAGE_EXTRACTOR_EXTRACT', function() {
  extractAndShowContent();
});

// 播放控制变量
let segmentPlayInterval = null;

// 记录上次滚动时间
let lastScrollTime = 0;
// 滚动冷却时间（毫秒）
const SCROLL_COOLDOWN = 400;
// 记录可视区域范围内的词项缓存
let visibleItemsCache = null;
// 缓存的可视区域有效期
let visibleItemsCacheTime = 0;
// 缓存有效期（毫秒）
const CACHE_VALIDITY = 1000;

// 提取正文并显示在遮罩层
function extractAndShowContent() {
  // 检查是否已存在遮罩层
  if (document.getElementById('webpage-extractor-overlay')) {
    return;
  }

  // 提取网页正文内容和图片
  const contentData = extractMainContent();
  
  // 创建遮罩层
  createOverlay(contentData);
  
  // 获取百度NLP分词结果 - 只对文本部分进行分词
  getAccessToken().then(token => {
    if (token) {
      segmentText(contentData.text, token).then(() => {
        // 确保分词结果加载完成后，启用分词按钮
        const viewSegmentBtn = document.getElementById('webpage-extractor-view-segment');
        if (viewSegmentBtn) {
          viewSegmentBtn.disabled = false;
          console.log('分词结果已准备好，启用分词按钮');
        }
      }).catch(error => {
        console.error('分词请求失败:', error);
      });
    }
  }).catch(error => {
    console.error('获取百度API Token失败:', error);
    showError('无法连接到百度NLP服务，请检查API配置');
  });
}

// 获取百度API的访问令牌
async function getAccessToken() {
  try {
    console.log('通过background.js获取百度API Token...');
    
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: "getAccessToken" }, response => {
        if (chrome.runtime.lastError) {
          console.error('发送消息时出错:', chrome.runtime.lastError);
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        
        if (response && response.success) {
          console.log('成功获取百度API Token');
          resolve(response.token);
        } else {
          const errorMsg = response && response.error ? response.error : '未知错误';
          console.error('获取Token失败:', errorMsg);
          reject(new Error(errorMsg));
        }
      });
    });
  } catch (error) {
    console.error('获取百度API Token失败详情:', error);
    return null;
  }
}

// 调用百度NLP分词API
async function segmentText(text, accessToken, retryCount = 0) {
  const MAX_RETRIES = 3; // 最大重试次数
  const RETRY_DELAY = 2000; // 重试延迟时间（毫秒）
  const MAX_SEGMENT_LENGTH = 15000; // 每段最大字符数（接近20000字节的限制，但保留一些安全余量）
  
  try {
    // 显示加载状态
    const loadingElement = document.getElementById('webpage-extractor-loading');
    if (loadingElement) {
      loadingElement.style.display = 'block';
      
      // 如果是重试，更新加载提示
      if (retryCount > 0) {
        loadingElement.textContent = `正在分词中...（第 ${retryCount} 次重试）`;
      } else {
        loadingElement.textContent = '正在分词中...';
      }
    }
    
    // 分析文本的段落结构，确保分段处理不破坏段落
    const paragraphs = text.split('\n');
    const validParagraphs = paragraphs.filter(p => p.trim().length > 0);
    
    // 记录每个段落在原文中的起始位置
    const paragraphPositions = [];
    let currentPos = 0;
    paragraphs.forEach(p => {
      if (p.trim().length > 0) {
        paragraphPositions.push({
          start: currentPos,
          end: currentPos + p.length,
          text: p
        });
      }
      // +1 是为了包含换行符
      currentPos += p.length + 1;
    });
    
    // 分段处理长文本，但尝试保持段落的完整性
    const allSegments = [];
    // 记录每个分词结果的原文位置，用于后续精确映射
    const segmentPositionMap = new Map();
    
    const textLength = text.length;
    console.log(`文本总长度为 ${textLength} 字符，开始分段处理...`);
    
    // 计算需要分成多少段
    const segmentCount = Math.ceil(textLength / MAX_SEGMENT_LENGTH);
    let processedSegments = 0;
    let totalOffset = 0; // 记录当前处理位置的累计偏移量
    
    // 更新加载提示为分段处理
    if (loadingElement && segmentCount > 1) {
      loadingElement.textContent = `正在分词中...（1/${segmentCount}）`;
    }
    
    // 如果只有一段，直接处理
    if (segmentCount === 1) {
      try {
        const singleSegment = await sendSegmentRequest(text, accessToken, retryCount);
        if (singleSegment && singleSegment.success && singleSegment.result) {
          if (loadingElement) {
            loadingElement.style.display = 'none';
          }
          
          // 为每个词项添加原文位置信息
          let positionOffset = 0;
          singleSegment.result.items.forEach(item => {
            const itemText = item.item || '';
            if (itemText) {
              // 查找当前词在原文中的位置
              const startPos = text.indexOf(itemText, positionOffset);
              if (startPos !== -1) {
                // 更新搜索偏移量，避免重复匹配
                positionOffset = startPos + itemText.length;
                // 存储位置信息
                segmentPositionMap.set(item, {
                  start: startPos,
                  end: startPos + itemText.length,
                  text: itemText
                });
              }
            }
          });
          
          // 根据位置信息为每个词项确定所属段落
          singleSegment.result.items.forEach(item => {
            const posInfo = segmentPositionMap.get(item);
            if (posInfo) {
              // 查找词项所属的段落
              const paragraphIndex = findParagraphByPosition(posInfo.start, paragraphPositions);
              if (paragraphIndex !== -1) {
                item.paragraphIndex = paragraphIndex;
              }
            }
          });
          
          displaySegmentResult(singleSegment.result.items, paragraphPositions);
          return {
            items: singleSegment.result.items,
            paragraphPositions: paragraphPositions
          };
        } else {
          throw new Error(singleSegment && singleSegment.error ? singleSegment.error : '分词失败');
        }
      } catch (error) {
        console.error('单段分词失败:', error);
        throw error;
      }
    }
    
    // 多段处理，尝试保持段落完整性
    for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex++) {
      const segmentStart = segmentIndex * MAX_SEGMENT_LENGTH;
      // 找到合适的段落边界作为分段点
      let segmentEnd = findOptimalSegmentEnd(segmentStart, MAX_SEGMENT_LENGTH, paragraphPositions);
      // 如果是最后一段或找不到合适的边界，直接使用最大长度
      if (segmentEnd === -1 || segmentEnd >= textLength) {
        segmentEnd = Math.min(segmentStart + MAX_SEGMENT_LENGTH, textLength);
      }
      
      // 获取当前段落的文本
      const currentSegmentText = text.substring(segmentStart, segmentEnd);
      processedSegments++;
      
      // 更新加载状态
      if (loadingElement) {
        loadingElement.textContent = `正在分词中...（${processedSegments}/${segmentCount}）`;
      }
      
      try {
        // 发送分词请求
        const response = await sendSegmentRequest(currentSegmentText, accessToken, retryCount);
        
        if (response && response.success && response.result && response.result.items) {
          // 为该段的每个词项添加位置信息
          let positionOffset = 0;
          response.result.items.forEach(item => {
            const itemText = item.item || '';
            if (itemText) {
              // 在当前段中查找词的位置
              const localStart = currentSegmentText.indexOf(itemText, positionOffset);
              if (localStart !== -1) {
                // 计算在原文中的绝对位置
                const globalStart = segmentStart + localStart;
                // 更新搜索偏移量
                positionOffset = localStart + itemText.length;
                // 存储位置信息
                segmentPositionMap.set(item, {
                  start: globalStart,
                  end: globalStart + itemText.length,
                  text: itemText
                });
                
                // 查找词项所属的段落
                const paragraphIndex = findParagraphByPosition(globalStart, paragraphPositions);
                if (paragraphIndex !== -1) {
                  item.paragraphIndex = paragraphIndex;
                }
              }
            }
          });
          
          // 将当前段的分词结果添加到总结果中
          allSegments.push(...response.result.items);
          console.log(`段落 ${processedSegments}/${segmentCount} 分词成功，获取了 ${response.result.items.length} 个词项`);
          
          // 更新分段起始位置
          totalOffset = segmentEnd;
        } else {
          console.error(`段落 ${processedSegments}/${segmentCount} 分词失败:`, response);
          throw new Error(response && response.error ? response.error : '分词失败');
        }
        
        // 如果不是最后一段，添加延迟避免API限流
        if (processedSegments < segmentCount) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      } catch (error) {
        console.error(`段落 ${processedSegments}/${segmentCount} 处理失败:`, error);
        
        // 检查是否是QPS限制错误，如果是则等待后重试
        if (error.message && error.message.includes('qps limit') && retryCount < MAX_RETRIES) {
          console.log(`QPS限制错误，${RETRY_DELAY/1000}秒后重试...`);
          
          if (loadingElement) {
            loadingElement.textContent = `API调用频率超限，等待中...`;
          }
          
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
          
          // 递归调用自身，从当前段继续处理
          const remainingText = text.substring(totalOffset);
          const remainingResult = await segmentText(remainingText, accessToken, retryCount + 1);
          
          if (remainingResult && remainingResult.items) {
            // 需要调整剩余部分词项的位置信息
            remainingResult.items.forEach(item => {
              const posInfo = segmentPositionMap.get(item);
              if (posInfo) {
                posInfo.start += totalOffset;
                posInfo.end += totalOffset;
                segmentPositionMap.set(item, posInfo);
              }
              
              // 调整段落索引
              if (item.paragraphIndex !== undefined) {
                // 需要找到当前位置对应的原始段落
                const adjustedPosition = posInfo ? posInfo.start : -1;
                if (adjustedPosition !== -1) {
                  const paragraphIndex = findParagraphByPosition(adjustedPosition, paragraphPositions);
                  if (paragraphIndex !== -1) {
                    item.paragraphIndex = paragraphIndex;
                  }
                }
              }
            });
            
            allSegments.push(...remainingResult.items);
          }
          
          break; // 跳出循环，因为剩余部分已递归处理
        } else {
          // 其他错误则继续尝试下一段
          showError(`段落 ${processedSegments} 分词失败: ${error.message}`);
        }
      }
    }
    
    // 隐藏加载状态
    if (loadingElement) {
      loadingElement.style.display = 'none';
    }
    
    // 处理所有分词结果
    if (allSegments.length > 0) {
      console.log(`分词完成，总计 ${allSegments.length} 个词项`);
      // 验证和完善位置信息
      verifyAndCompletePositions(allSegments, segmentPositionMap, paragraphPositions, text);
      
      displaySegmentResult(allSegments, paragraphPositions);
      return {
        items: allSegments,
        paragraphPositions: paragraphPositions
      };
    } else {
      console.error('未获取到有效的分词结果');
      showError('分词结果为空');
      return {
        items: [],
        paragraphPositions: paragraphPositions
      };
    }
  } catch (error) {
    console.error('分词请求失败:', error);
    showError('分词请求失败，请检查网络连接');
    
    // 隐藏加载状态
    const loadingElement = document.getElementById('webpage-extractor-loading');
    if (loadingElement) {
      loadingElement.style.display = 'none';
    }
    
    throw error;
  }
}

// 找到一个位置所在的段落索引
function findParagraphByPosition(position, paragraphPositions) {
  for (let i = 0; i < paragraphPositions.length; i++) {
    const p = paragraphPositions[i];
    if (position >= p.start && position < p.end) {
      return i;
    }
  }
  return -1;
}

// 寻找最佳分段点（尽量在段落边界处分割）
function findOptimalSegmentEnd(startPos, maxLength, paragraphPositions) {
  const idealEnd = startPos + maxLength;
  
  // 找到理想结束位置之前或正好处于段落边界的最后一个位置
  let bestEnd = -1;
  
  for (const p of paragraphPositions) {
    // 如果段落结束位置在理想范围内，记录它
    if (p.end <= idealEnd && p.end > startPos) {
      bestEnd = p.end;
    }
    // 如果段落开始位置已经超过理想范围，跳出
    if (p.start > idealEnd) {
      break;
    }
  }
  
  return bestEnd;
}

// 验证和完善位置信息
function verifyAndCompletePositions(segments, positionMap, paragraphPositions, originalText) {
  // 过滤掉空项
  const validSegments = segments.filter(item => item && item.item && item.item.trim().length > 0);
  
  // 如果过滤后数组长度变化，更新segments数组
  if (validSegments.length < segments.length) {
    console.log(`过滤掉了 ${segments.length - validSegments.length} 个空值词项`);
    segments.length = 0; // 清空原数组
    segments.push(...validSegments); // 重新填充过滤后的内容
  }
  
  // 针对缺少段落索引的词项，根据位置补充或修正
  segments.forEach(item => {
    const posInfo = positionMap.get(item);
    
    // 如果没有位置信息或段落索引，尝试补充
    if (!item.paragraphIndex && posInfo) {
      const paragraphIndex = findParagraphByPosition(posInfo.start, paragraphPositions);
      if (paragraphIndex !== -1) {
        item.paragraphIndex = paragraphIndex;
      }
    }
    
    // 如果既没有位置信息也没有段落索引，作为特殊情况处理
    if (!posInfo && item.item && !item.paragraphIndex) {
      // 尝试在原文中找到这个词
      const itemText = item.item;
      const textIndex = originalText.indexOf(itemText);
      
      if (textIndex !== -1) {
        // 找到词在原文中的位置，更新位置信息
        positionMap.set(item, {
          start: textIndex,
          end: textIndex + itemText.length,
          text: itemText
        });
        
        // 确定段落
        const paragraphIndex = findParagraphByPosition(textIndex, paragraphPositions);
        if (paragraphIndex !== -1) {
          item.paragraphIndex = paragraphIndex;
        }
      }
    }
  });
  
  console.log(`位置验证完成，共处理了 ${segments.length} 个词项`);
}

// 发送分词请求到background.js
async function sendSegmentRequest(text, accessToken, retryCount = 0) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ 
      action: "segmentText", 
      text: text, 
      token: accessToken 
    }, response => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

/**
 * 显示分词结果
 * @param {Array} segmentResult - 分词结果数组
 * @param {Array|Object} paragraphPositions - 段落位置信息（可选）
 */
function displaySegmentResult(segmentResult, paragraphPositions) {
  // 确保有分词样式
  createCustomStyles();
  
  // 检查分词结果是否为空
  if (!segmentResult || segmentResult.length === 0) {
    console.error('分词结果为空');
    return;
  }
  
  // 过滤掉空值的分词项
  segmentResult = segmentResult.filter(item => 
    item && item.item && item.item.trim().length > 0
  );
  
  // 获取分词结果容器
  let segmentContainer = document.getElementById('webpage-extractor-segment-result');
  if (!segmentContainer) {
    console.error('无法找到分词结果容器');
    return;
  }
  
  // 清空容器
  segmentContainer.innerHTML = '';
  
  // 获取段落数量
  let paragraphCount = 0;
  if (paragraphPositions && Array.isArray(paragraphPositions)) {
    paragraphCount = paragraphPositions.length;
  } else if (paragraphPositions && paragraphPositions.paragraphPositions) {
    paragraphCount = paragraphPositions.paragraphPositions.length;
  } else {
    // 尝试从分词结果中获取最大段落索引
    paragraphCount = segmentResult.reduce((max, item) => {
      return Math.max(max, (item.paragraphIndex || 0) + 1);
    }, 0);
  }
  
  /*
  // 添加分词信息
  const segmentInfo = document.createElement('div');
  segmentInfo.className = 'segment-info';
  segmentInfo.textContent = `共分析 ${paragraphCount} 个段落，${segmentResult.length} 个分词项`;
  segmentContainer.appendChild(segmentInfo);
  */
  
  // 按段落分组排序分词结果
  const resultByParagraph = {};
  
  segmentResult.forEach(item => {
    // 确保有效的段落索引
    const paragraphIndex = item.paragraphIndex !== undefined ? item.paragraphIndex : 0;
    if (!resultByParagraph[paragraphIndex]) {
      resultByParagraph[paragraphIndex] = [];
    }
    resultByParagraph[paragraphIndex].push(item);
  });
  
  // 创建分词内容区域
  const segmentContent = document.createElement('div');
  segmentContent.className = 'segment-content';
  
  // 获取原始内容数据
  const contentData = window.extractedContentData || {};
  const images = contentData.images || [];
  
  // 对图片按位置进行分组
  const imagesByParagraph = {};
  const headerImages = [];
  
  images.forEach(image => {
    const position = image.position || 0;
    if (position === -1) {
      headerImages.push(image);
    } else {
      imagesByParagraph[position] = imagesByParagraph[position] || [];
      imagesByParagraph[position].push(image);
    }
  });
  
  // 先添加头图（如果有）
  headerImages.forEach(image => {
    const imgContainer = document.createElement('div');
    imgContainer.className = 'extracted-image-container header-image';
    
    const img = document.createElement('img');
    img.src = image.src;
    img.alt = image.alt || '';
    img.className = 'extracted-image-header';
    
    imgContainer.appendChild(img);
    segmentContent.appendChild(imgContainer);
  });
  
  // 遍历段落创建分词结果，并在适当位置添加图片
  Object.keys(resultByParagraph).sort((a, b) => parseInt(a) - parseInt(b)).forEach(paragraphIndex => {
    const items = resultByParagraph[paragraphIndex];
    const pIndex = parseInt(paragraphIndex);
    
    // 创建段落元素
    const paragraphElement = document.createElement('div');
    paragraphElement.className = 'segment-paragraph';
    paragraphElement.setAttribute('data-paragraph-index', pIndex + 1);
    
    // 添加分词项（确保不添加空值）
    items.forEach(item => {
      // 再次检查确保项不为空
      if (item && item.item && item.item.trim()) {
        const segmentItem = document.createElement('span');
        segmentItem.className = 'segment-item';
        segmentItem.textContent = item.item.trim();
        
        // 添加点击事件
        segmentItem.addEventListener('click', function() {
          // 移除其他活动状态
          document.querySelectorAll('.segment-item.active').forEach(el => {
            el.classList.remove('active');
          });
          
          // 添加当前活动状态
          this.classList.add('active');
        });
        
        paragraphElement.appendChild(segmentItem);
      }
    });
    
    // 只有当段落有内容时才添加到结果中
    if (paragraphElement.childNodes.length > 0) {
      segmentContent.appendChild(paragraphElement);
      
      // 在段落后添加相关图片
      if (imagesByParagraph[pIndex]) {
        imagesByParagraph[pIndex].forEach(image => {
          const imgContainer = document.createElement('div');
          imgContainer.className = 'extracted-image-container';
          
          const img = document.createElement('img');
          img.src = image.src;
          img.alt = image.alt || '';
          img.className = 'extracted-image';
          
          imgContainer.appendChild(img);
          segmentContent.appendChild(imgContainer);
        });
      }
    }
  });
  
  // 添加任何未与段落关联的图片（如果有）
  Object.keys(imagesByParagraph).forEach(position => {
    if (position < 0 || position >= paragraphCount) {
      imagesByParagraph[position].forEach(image => {
        const imgContainer = document.createElement('div');
        imgContainer.className = 'extracted-image-container';
        
        const img = document.createElement('img');
        img.src = image.src;
        img.alt = image.alt || '';
        img.className = 'extracted-image';
        
        imgContainer.appendChild(img);
        segmentContent.appendChild(imgContainer);
      });
    }
  });
  
  // 将内容添加到容器
  segmentContainer.appendChild(segmentContent);
  
  // 启用分词按钮
  const viewSegmentBtn = document.getElementById('webpage-extractor-view-segment');
  if (viewSegmentBtn) {
    viewSegmentBtn.disabled = false;
    console.log('分词结果已加载完成，启用分词按钮');
  }
}

// 通用工具函数 - 创建图片容器
function createImageElement(image, isHeader = false) {
  const imgContainer = document.createElement('div');
  imgContainer.className = `extracted-image-container${isHeader ? ' header-image' : ''}`;
  
  const img = document.createElement('img');
  img.src = image.src;
  img.alt = image.alt || '';
  img.className = 'extracted-image';
  img.setAttribute('data-is-extracted-image', 'true');
  
  imgContainer.appendChild(img);
  return imgContainer;
}

// 通用工具函数 - 判断段落类型
function getParagraphType(paragraph) {
  if (paragraph.includes('• ') || /\d+\.\s/.test(paragraph)) {
    return { 
      type: 'list', 
      isBullet: paragraph.includes('• ')
    };
  } else if (/^[A-Z0-9][\s\S]{0,50}$/.test(paragraph) && 
            paragraph.length < 80 && 
            !paragraph.includes('。')) {
    return { type: 'heading' };
  }
  return { type: 'paragraph' };
}

// 通用工具函数 - 创建段落元素
function createParagraphElement(paragraph, type) {
  // 处理列表
  if (type.type === 'list') {
    const isBullet = type.isBullet;
    const listElement = document.createElement(isBullet ? 'ul' : 'ol');
    
    // 分割列表项
    const lines = paragraph.split('\n');
    let hasItems = false;
    
    lines.forEach(line => {
      if (line.trim()) {
        // 确保是列表项
        if ((isBullet && line.includes('• ')) || (!isBullet && /^\d+\.\s/.test(line))) {
          const listItem = document.createElement('li');
          // 移除项目符号或数字
          listItem.textContent = isBullet 
            ? line.replace(/^•\s/, '') 
            : line.replace(/^\d+\.\s/, '');
          listElement.appendChild(listItem);
          hasItems = true;
        }
      }
    });
    
    if (hasItems) {
      return listElement;
    }
    
    // 如果没有有效列表项，降级为普通段落
    const fallbackP = document.createElement('p');
    fallbackP.textContent = paragraph.trim();
    return fallbackP;
  } 
  
  // 处理标题和普通段落
  const element = document.createElement(type.type === 'heading' ? 'h3' : 'p');
  element.textContent = paragraph.trim();
  return element;
}

// 通用工具函数 - 处理图片分组
function groupImagesByPosition(images) {
  const imagesByParagraph = {};
  let headerImages = [];
  
  images.forEach(image => {
    const position = image.position || 0;
    // 收集头图（position为-1的图片）
    if (position === -1) {
      headerImages.push(image);
    } else {
      imagesByParagraph[position] = imagesByParagraph[position] || [];
      imagesByParagraph[position].push(image);
    }
  });
  
  return { imagesByParagraph, headerImages };
}

// 通用工具函数 - 检测图片大小是否足够作为头图
function isLargeEnoughForHeader(imgElement) {
  const imgWidth = imgElement.width || imgElement.clientWidth;
  const imgHeight = imgElement.height || imgElement.clientHeight;
  return (imgWidth > 300 || imgHeight > 200);
}

// 构建包含文本和图片的混合内容
function buildContentWithImages(container, contentData) {
  if (!contentData || !contentData.text) {
    container.textContent = '无法提取内容';
    return;
  }
  
  // 清空容器
  container.innerHTML = '';
  
  const text = contentData.text;
  const images = contentData.images || [];
  
  // 对图片按位置进行分组
  const { imagesByParagraph, headerImages } = groupImagesByPosition(images);
  
  // 先添加头图（如果有）
  headerImages.forEach(image => {
    container.appendChild(createImageElement(image, true));
  });
  
  // 将文本按段落分割
  const paragraphs = text.split('\n');
  
  // 如果没有图片，直接显示文本
  if (images.length === 0) {
    paragraphs.forEach(paragraph => {
      if (paragraph.trim()) {
        const type = getParagraphType(paragraph);
        container.appendChild(createParagraphElement(paragraph, type));
      }
    });
    return;
  }
  
  // 按照段落顺序插入文本和图片
  paragraphs.forEach((paragraph, index) => {
    if (paragraph.trim()) {
      // 创建并添加段落元素
      const type = getParagraphType(paragraph);
      container.appendChild(createParagraphElement(paragraph, type));
      
      // 在段落后添加与该段落位置相关的图片
      if (imagesByParagraph[index]) {
        imagesByParagraph[index].forEach(image => {
          container.appendChild(createImageElement(image));
        });
      }
    }
  });
  
  // 添加剩余的图片（如果有未分配位置的图片）
  const lastParagraphIndex = paragraphs.length - 1;
  const remainingPositions = [-1, paragraphs.length, lastParagraphIndex + 1];
  
  const remainingImages = remainingPositions
    .flatMap(pos => imagesByParagraph[pos] || [])
    .filter(image => !headerImages.some(h => h.src === image.src)); // 排除已作为头图的图片
  
  remainingImages.forEach(image => {
    container.appendChild(createImageElement(image));
  });
}

// 构建包含图片的分词结果
function buildSegmentResultWithImages(segmentHtml, images) {
  if (!images || !images.length) {
    return `<div id="segment-formatted" class="segment-content">${segmentHtml}</div>`;
  }
  
  // 创建一个临时容器来构建DOM
  const tempContainer = document.createElement('div');
  tempContainer.id = 'segment-formatted';
  tempContainer.className = 'segment-content';
  
  // 对图片按位置进行分组
  const { imagesByParagraph, headerImages } = groupImagesByPosition(images);
  
  // 先添加头图（如果有）
  headerImages.forEach(image => {
    tempContainer.appendChild(createImageElement(image, true));
  });
  
  // 分析原始内容的段落结构
  const originalParagraphs = window.extractedContentData.text.split('\n');
  const validParagraphs = originalParagraphs.filter(p => p.trim().length > 0);
  const paragraphCount = validParagraphs.length;
  
  console.log(`原始内容有 ${paragraphCount} 个段落，使用精确段落映射`);
  
  // 如果只有一个段落或没有有效段落，直接添加所有分词结果
  if (paragraphCount <= 1) {
    const segmentParagraph = document.createElement('div');
    segmentParagraph.className = 'segment-paragraph';
    segmentParagraph.innerHTML = segmentHtml;
    tempContainer.appendChild(segmentParagraph);
    
    // 添加所有非头图的图片
    Object.values(imagesByParagraph).flat().forEach(image => {
      tempContainer.appendChild(createImageElement(image));
    });
  } else {
    // 获取所有分词项
    const contentDiv = document.createElement('div');
    contentDiv.className = 'segment-content-wrapper';
    contentDiv.innerHTML = segmentHtml;
    const segmentItems = Array.from(contentDiv.querySelectorAll('.segment-item'));
    const totalItems = segmentItems.length;
    
    // 如果没有词项，直接返回
    if (totalItems === 0) {
      tempContainer.innerHTML = segmentHtml;
      return tempContainer.outerHTML;
    }
    
    // 按照原始段落结构分析段落类型
    const paragraphTypes = validParagraphs.map(getParagraphType);
    
    // 创建段落容器数组，用于按段落索引分配词项
    const paragraphContainers = [];
    for (let i = 0; i < paragraphCount; i++) {
      const paragraphType = paragraphTypes[i];
      const paragraphDiv = document.createElement('div');
      
      if (paragraphType.type === 'heading') {
        paragraphDiv.className = 'segment-paragraph segment-heading';
      } else if (paragraphType.type === 'list') {
        paragraphDiv.className = 'segment-paragraph segment-list';
        paragraphDiv.setAttribute('data-list-type', paragraphType.isBullet ? 'bullet' : 'number');
      } else {
        paragraphDiv.className = 'segment-paragraph';
      }
      
      paragraphContainers.push(paragraphDiv);
    }
    
    // 检查是否有段落索引信息
    const hasExplicitMapping = segmentItems.some(item => {
      const dataItem = item.__antmlData || {};
      return typeof dataItem.paragraphIndex !== 'undefined';
    });
    
    if (hasExplicitMapping) {
      // 使用显式的段落索引信息分配词项
      segmentItems.forEach(item => {
        // 从DOM元素获取数据（如果有）
        const paragraphIndex = item.getAttribute('data-paragraph-index');
        
        if (paragraphIndex !== null && paragraphIndex >= 0 && paragraphIndex < paragraphCount) {
          // 有明确的段落索引，直接添加到对应段落
          paragraphContainers[parseInt(paragraphIndex)].appendChild(item.cloneNode(true));
        } else {
          // 没有明确索引，使用比例分配的备用方法
          const estimatedIndex = Math.floor(Math.random() * paragraphCount); // 简单随机分配作为后备
          paragraphContainers[estimatedIndex].appendChild(item.cloneNode(true));
        }
      });
    } else {
      // 如果没有显式映射，回退到基于段落比例的分配方法
      const itemDistribution = distributeParagraphItems(totalItems, validParagraphs);
      
      // 按段落创建分词内容
      let itemIndex = 0;
      for (let i = 0; i < paragraphCount; i++) {
        for (let j = 0; j < itemDistribution[i] && itemIndex < totalItems; j++) {
          paragraphContainers[i].appendChild(segmentItems[itemIndex].cloneNode(true));
          itemIndex++;
        }
      }
    }
    
    // 将段落容器添加到主容器
    paragraphContainers.forEach((container, index) => {
      tempContainer.appendChild(container);
      
      // 在段落后面添加对应的图片
      if (imagesByParagraph[index]) {
        imagesByParagraph[index].forEach(image => {
          tempContainer.appendChild(createImageElement(image));
        });
      }
    });
    
    // 添加剩余的图片
    const remainingImages = Object.entries(imagesByParagraph)
      .filter(([pos, _]) => {
        const position = parseInt(pos);
        return position >= paragraphCount || position < 0;
      })
      .flatMap(([_, imgs]) => imgs)
      .filter(image => !headerImages.some(h => h.src === image.src)); // 排除已作为头图的图片
    
    remainingImages.forEach(image => {
      tempContainer.appendChild(createImageElement(image));
    });
  }
  
  return tempContainer.outerHTML;
}

// 计算段落词项分布
function distributeParagraphItems(totalItems, paragraphs) {
  const distribution = [];
  let totalLength = 0;
  
  // 计算总文本长度
  paragraphs.forEach(p => totalLength += p.length);
  
  // 根据段落长度计算分配比例
  paragraphs.forEach((p, i) => {
    const ratio = p.length / totalLength;
    distribution[i] = Math.round(totalItems * ratio);
  });
  
  // 确保所有词项都被分配
  let assignedItems = distribution.reduce((a, b) => a + b, 0);
  let diff = totalItems - assignedItems;
  
  // 调整分配数量，确保总数正确
  if (diff !== 0) {
    let idx = 0;
    while (diff !== 0) {
      if (diff > 0) {
        distribution[idx]++;
        diff--;
      } else if (distribution[idx] > 1) {
        distribution[idx]--;
        diff++;
      }
      idx = (idx + 1) % paragraphs.length;
    }
  }
  
  return distribution;
}

// 播放下一个分词项
function playNextSegment() {
  if (!window.segmentPlayer || !window.segmentPlayer.isPlaying) return;
  
  const items = window.segmentPlayer.items;
  if (!items || items.length === 0) return;
  
  // 清除上一个活跃项，恢复其透明度
  if (window.segmentPlayer.currentIndex > 0) {
    items[window.segmentPlayer.currentIndex - 1].classList.remove('active');
    // 不需要特别设置opacity，CSS会自动恢复默认值0.3
  }
  
  // 寻找下一个有效的分词项（跳过图片元素）
  while (window.segmentPlayer.currentIndex < items.length) {
    const currentItem = items[window.segmentPlayer.currentIndex];
    
    // 检查是否是图片元素，如果是则跳过
    if (currentItem.hasAttribute('data-is-extracted-image') || 
        currentItem.parentElement.hasAttribute('data-is-extracted-image') ||
        currentItem.classList.contains('extracted-image-container')) {
      window.segmentPlayer.currentIndex++;
      continue;
    }
    
    // 找到了有效的分词项
    currentItem.classList.add('active');
    
    // 只有当前项不在可视区域内时才滚动，并且限制滚动频率
    if (!isElementInViewport(currentItem)) {
      const now = Date.now();
      if (now - lastScrollTime > SCROLL_COOLDOWN) {
        // 使用更平滑的滚动
        smoothScrollToElement(currentItem);
        lastScrollTime = now;
      }
    }
    
    // 移动到下一项
    window.segmentPlayer.currentIndex++;
    return;
  }
  
  // 如果到达这里，说明已经播放完成或没有找到有效的分词项
  window.segmentPlayer.currentIndex = 0;
  window.segmentPlayer.isPlaying = false;
  
  const playButton = document.getElementById('segment-play-button');
  if (playButton) {
    playButton.textContent = '播放';
    playButton.classList.remove('playing');
  }
  
  clearInterval(segmentPlayInterval);
  segmentPlayInterval = null;
}

// 检查元素是否在视口中
function isElementInViewport(el) {
  const now = Date.now();
  
  // 如果缓存过期，重新计算可视区域
  if (!visibleItemsCache || now - visibleItemsCacheTime > CACHE_VALIDITY) {
    const rect = el.getBoundingClientRect();
    const contentContainer = document.getElementById('webpage-extractor-content');
    
    if (!contentContainer) return false;
    
    const containerRect = contentContainer.getBoundingClientRect();
    
    // 计算视口高度（适应新的滚动到顶部而不是中心的行为）
    const viewportTop = containerRect.top + 20; // 与滚动函数中的顶部边距保持一致
    const viewportBottom = containerRect.bottom; // 整个可视区域下方都算在内
    
    // 更新缓存
    visibleItemsCache = {
      top: viewportTop,
      bottom: viewportBottom
    };
    visibleItemsCacheTime = now;
  }
  
  // 使用缓存的视口信息
  const rect = el.getBoundingClientRect();
  return (
    rect.top >= visibleItemsCache.top &&
    rect.bottom <= visibleItemsCache.bottom
  );
}

// 平滑滚动到元素
function smoothScrollToElement(el) {
  const contentContainer = document.getElementById('webpage-extractor-content');
  if (!contentContainer) return;
  
  const rect = el.getBoundingClientRect();
  const containerRect = contentContainer.getBoundingClientRect();
  
  // 修改：计算元素到容器顶部的距离，而不是中心
  // 保留一些顶部边距（例如，20px）以提高可读性
  const scrollAmount = rect.top - containerRect.top - 20;
  
  // 使用更平滑的滚动方式
  contentContainer.scrollBy({
    top: scrollAmount,
    behavior: 'smooth'
  });
}

// 切换视图（原文/分词结果）
function switchView(viewType) {
  console.log('切换视图到:', viewType);
  
  const originalText = document.getElementById('webpage-extractor-text');
  const segmentResult = document.getElementById('webpage-extractor-segment-result');
  const viewOriginalBtn = document.getElementById('webpage-extractor-view-original');
  const viewSegmentBtn = document.getElementById('webpage-extractor-view-segment');
  const playerControls = document.getElementById('segment-player-controls');
  
  // 确保所有元素存在
  if (!originalText || !segmentResult || !viewOriginalBtn || !viewSegmentBtn) {
    console.error('切换视图失败：找不到必要的元素');
    return;
  }
  
  if (viewType === 'original') {
    // 显示原文，隐藏分词结果
    originalText.style.display = 'block';
    segmentResult.style.display = 'none';
    viewOriginalBtn.classList.add('active');
    viewSegmentBtn.classList.remove('active');
    
    // 隐藏播放控制
    if (playerControls) {
      playerControls.style.display = 'none';
    }
    
    // 停止播放
    if (window.segmentPlayer && window.segmentPlayer.isPlaying) {
      togglePlaySegments();
    }
    
    // 重置所有分词项到默认透明度
    resetAllSegmentItems();
    
    console.log('已切换到原文视图');
  } else if (viewType === 'segment') {
    // 确保分词结果已准备好且分词按钮未禁用
    if (segmentResult.innerHTML.trim() === '' || viewSegmentBtn.disabled) {
      console.log('分词结果尚未准备好，无法切换视图');
      showError('分词结果正在加载中，请稍候...');
      return;
    }
    
    // 隐藏原文，显示分词结果
    originalText.style.display = 'none';
    segmentResult.style.display = 'block';
    viewSegmentBtn.classList.add('active');
    viewOriginalBtn.classList.remove('active');
    
    // 显示播放控制
    if (playerControls) {
      playerControls.style.display = 'flex';
    }
    
    console.log('已切换到分词结果视图');
  }
}

// 切换播放/暂停状态
function togglePlaySegments() {
  const playButton = document.getElementById('segment-play-button');
  if (!playButton) return;
  
  // 初始化播放器状态
  window.segmentPlayer = window.segmentPlayer || {
    isPlaying: false,
    currentIndex: 0,
    speed: 3,
    items: []
  };
  
  // 获取所有分词项，但排除图片元素
  const segmentItems = Array.from(document.querySelectorAll('.segment-item, .extracted-image-container, .extracted-image'));
  window.segmentPlayer.items = segmentItems;
  
  if (window.segmentPlayer.isPlaying) {
    // 暂停播放
    window.segmentPlayer.isPlaying = false;
    playButton.textContent = '播放';
    playButton.classList.remove('playing');
    
    // 清除播放间隔
    if (segmentPlayInterval) {
      clearInterval(segmentPlayInterval);
      segmentPlayInterval = null;
    }
    // 暂停时不重置，保持当前高亮状态
  } else {
    // 开始播放
    window.segmentPlayer.isPlaying = true;
    playButton.textContent = '暂停';
    playButton.classList.add('playing');
    
    // 更新当前速度
    const slider = document.getElementById('segment-speed-slider');
    if (slider) {
      window.segmentPlayer.speed = parseInt(slider.value);
    }
    
    // 设置播放间隔
    segmentPlayInterval = setInterval(playNextSegment, 1000 / window.segmentPlayer.speed);
  }
}

// 重置所有分词项状态
function resetAllSegmentItems() {
  const segmentItems = document.querySelectorAll('.segment-item');
  segmentItems.forEach(item => {
    item.classList.remove('active');
    // 会自动恢复到CSS中定义的默认透明度
  });
  
  // 如果存在播放器状态，重置其索引
  if (window.segmentPlayer) {
    window.segmentPlayer.currentIndex = 0;
  }
}

// 显示错误信息
function showError(message) {
  const errorElement = document.createElement('div');
  errorElement.className = 'webpage-extractor-error';
  errorElement.textContent = message;
  
  const contentArea = document.getElementById('webpage-extractor-content');
  if (contentArea) {
    contentArea.appendChild(errorElement);
  }
  
  // 5秒后自动移除错误提示
  setTimeout(() => {
    if (errorElement.parentNode) {
      errorElement.parentNode.removeChild(errorElement);
    }
  }, 5000);
}

// 提取网页主要内容的函数
function extractMainContent() {
  // 常见的内容容器选择器
  const contentSelectors = [
    'article',
    '.content',
    '.post',
    '.article',
    '.post-content',
    '.entry-content',
    'main',
    '#content',
    '#main'
  ];

  let mainContent = '';
  let mainElement = null;
  let maxTextLength = 0;
  let contentImages = [];

  // 尝试找到包含最多文本的内容元素
  contentSelectors.forEach(selector => {
    const elements = document.querySelectorAll(selector);
    elements.forEach(element => {
      const textLength = element.innerText.trim().length;
      if (textLength > maxTextLength) {
        maxTextLength = textLength;
        mainElement = element;
      }
    });
  });

  // 执行内容提取策略
  if (mainElement && maxTextLength >= 1000) {
    // 直接使用找到的主内容元素
    findHeaderImage(mainElement, contentImages);
    mainContent = extractTextAndImages(mainElement, contentImages);
  } else {
    // 尝试替代策略
    mainContent = extractWithAlternativeStrategy(contentImages);
  }

  // 如果内容太少，使用页面全文
  if (mainContent.length < 500) {
    // 直接使用body作为容器，尝试提取结构化内容
    mainContent = extractTextAndImages(document.body, contentImages);
    
    // 如果还是不行，退化为纯文本提取
    if (mainContent.length < 500) {
      mainContent = document.body.innerText;
      contentImages = []; // 重置图片列表
    }
  }

  return { text: mainContent, images: contentImages };
}

// 尝试查找头图
function findHeaderImage(mainElement, contentImages) {
  // 检查是否有头图
  const allImages = document.querySelectorAll('img');
  let headerImgFound = false;
  
  // 遍历所有图片，找出位于主内容前且足够大的图片
  allImages.forEach(img => {
    // 如果已找到头图则跳过
    if (headerImgFound) return;
    
    // 检查图片是否在主内容前
    if (mainElement.compareDocumentPosition(img) & Node.DOCUMENT_POSITION_PRECEDING) {
      // 判断图片是否足够大
      if (isLargeEnoughForHeader(img)) {
            contentImages.push({
          src: img.src,
          alt: img.alt || '',
          position: -1  // 特殊标记为头图
        });
        headerImgFound = true;
      }
    }
  });
  
  // 如果还没找到头图，检查主元素前的兄弟元素
  if (!headerImgFound) {
    let prevElement = mainElement.previousElementSibling;
    let headerImageChecked = false;
    
    while (!headerImageChecked && prevElement) {
      // 检查是否是图片容器或包含大图的元素
      const hasImage = prevElement.tagName === 'IMG' || 
                       prevElement.querySelector('img') ||
                       prevElement.tagName === 'FIGURE';
      
      // 如果没找到图片，检查上一级元素
      if (!hasImage) {
        // 最多检查5个前置元素
        if (mainElement.previousElementSibling !== prevElement.previousElementSibling) {
          prevElement = prevElement.previousElementSibling;
        } else {
          headerImageChecked = true;
        }
        continue;
      }
      
      // 找到了可能的头图
      const imgElement = prevElement.tagName === 'IMG' ? 
                        prevElement : 
                        (prevElement.tagName === 'FIGURE' ? 
                        prevElement.querySelector('img') : 
                        prevElement.querySelector('img'));
                        
      if (imgElement && imgElement.src && isLargeEnoughForHeader(imgElement)) {
            contentImages.push({
              src: imgElement.src,
              alt: imgElement.alt || '',
          position: -1  // 特殊标记为头图
        });
      }
      
      headerImageChecked = true;
    }
  }
}

// 使用替代策略提取内容
function extractWithAlternativeStrategy(contentImages) {
  // 查找文章内容区域 - 选择包含多个段落的容器
  const containers = findContentContainers();
  
  if (containers.length > 0) {
    // 使用找到的最佳容器
    const mainElement = containers[0].element;
    findHeaderImage(mainElement, contentImages);
    return extractTextAndImages(mainElement, contentImages);
  } else {
    // 回退到所有段落的方法
    return extractFromParagraphs(contentImages);
  }
}

// 查找可能的内容容器
function findContentContainers() {
  const containers = [];
  
  document.querySelectorAll('div, section, main').forEach(container => {
    // 计算直接子段落数量
    const paragraphs = container.querySelectorAll(':scope > p');
    if (paragraphs.length >= 3) {
      // 计算段落中的总文本长度
      let totalTextLength = 0;
      paragraphs.forEach(p => {
        totalTextLength += p.innerText.trim().length;
      });
      
      // 如果文本足够长，将其添加到候选容器
      if (totalTextLength > 500) {
        containers.push({
          element: container,
          paragraphCount: paragraphs.length,
          textLength: totalTextLength
        });
      }
    }
  });
  
  // 按文本长度排序容器
  return containers.sort((a, b) => b.textLength - a.textLength);
}

// 从所有段落中提取内容
function extractFromParagraphs(contentImages) {
  const paragraphs = document.querySelectorAll('p');
  let paragraphTexts = [];
  
  // 查找可能的头图
  findPossibleHeaderImage(contentImages);
  const headerImgFound = contentImages.some(img => img.position === -1);
  
  // 过滤并处理段落
  paragraphs.forEach((p, index) => {
    const text = p.innerText.trim();
    if (text.length > 50) {
      // 检查相邻图片
      processAdjacentImages(p, paragraphTexts, contentImages, headerImgFound, index);
      
      // 添加段落文本
      paragraphTexts.push(text);
    }
  });
  
  return paragraphTexts.join('\n');
}

// 查找可能的头图
function findPossibleHeaderImage(contentImages) {
  const possibleHeaderImgs = document.querySelectorAll('img');
  
  for (const img of possibleHeaderImgs) {
    // 确保图片是在内容区域顶部
    const imgRect = img.getBoundingClientRect();
    const parentText = img.parentElement.innerText.trim();
    
    // 判断是否可能是头图（较大且位于页面上方）
    if (imgRect.width > 300 && imgRect.top < window.innerHeight / 2 && parentText.length < 200) {
      contentImages.push({
            src: img.src,
            alt: img.alt || '',
        position: -1  // 特殊标记为头图
      });
      return true;
    }
  }
  
  return false;
}

// 处理段落前后的图片
function processAdjacentImages(paragraph, paragraphTexts, contentImages, headerImgFound, index) {
  // 检查段落前的图片
  let prevSibling = paragraph.previousElementSibling;
  while (prevSibling && (prevSibling.tagName === 'IMG' || prevSibling.querySelector('img'))) {
    const imgElement = prevSibling.tagName === 'IMG' ? prevSibling : prevSibling.querySelector('img');
    if (imgElement && imgElement.src) {
      // 如果已经找到头图，且这是第一个段落的前图，则跳过
      if (headerImgFound && index === 0) {
        break;
      }
      
      contentImages.push({
        src: imgElement.src,
        alt: imgElement.alt || '',
        position: paragraphTexts.length > 0 ? paragraphTexts.length - 1 : -1
      });
    }
    prevSibling = prevSibling.previousElementSibling;
  }
  
  // 检查段落后的图片
  let nextSibling = paragraph.nextElementSibling;
  while (nextSibling && (nextSibling.tagName === 'IMG' || nextSibling.querySelector('img'))) {
    const imgElement = nextSibling.tagName === 'IMG' ? nextSibling : nextSibling.querySelector('img');
    if (imgElement && imgElement.src) {
      contentImages.push({
        src: imgElement.src,
        alt: imgElement.alt || '',
        position: paragraphTexts.length  // 放在当前段落末尾
      });
    }
    nextSibling = nextSibling.nextElementSibling;
  }
}

// 创建遮罩层并显示内容
function createOverlay(contentData) {
  // 创建遮罩层容器
  const overlay = document.createElement('div');
  overlay.id = 'webpage-extractor-overlay';
  
  // 创建顶栏
  const topBar = document.createElement('div');
  topBar.id = 'webpage-extractor-topbar';
  
  // 创建关闭按钮
  const closeButton = document.createElement('button');
  closeButton.id = 'webpage-extractor-close';
  closeButton.textContent = '关闭';
  closeButton.addEventListener('click', removeOverlay);
  
  // 创建视图切换按钮组
  const viewButtons = document.createElement('div');
  viewButtons.id = 'webpage-extractor-view-buttons';
  
  // 原文按钮
  const viewOriginalBtn = document.createElement('button');
  viewOriginalBtn.id = 'webpage-extractor-view-original';
  viewOriginalBtn.textContent = '原文';
  viewOriginalBtn.classList.add('active'); // 默认显示原文
  viewOriginalBtn.addEventListener('click', () => switchView('original'));
  
  // 分词按钮
  const viewSegmentBtn = document.createElement('button');
  viewSegmentBtn.id = 'webpage-extractor-view-segment';
  viewSegmentBtn.textContent = '分词结果';
  viewSegmentBtn.disabled = true; // 初始化时禁用分词按钮，直到分词结果准备好
  viewSegmentBtn.addEventListener('click', () => {
    if (!viewSegmentBtn.disabled) {
      switchView('segment');
      // 显示播放控制区域
      const playerControls = document.getElementById('segment-player-controls');
      if (playerControls) {
        playerControls.style.display = 'flex';
      }
    }
  });
  
  // 创建播放控制区
  const playerControls = document.createElement('div');
  playerControls.id = 'segment-player-controls';
  playerControls.className = 'player-controls';
  playerControls.style.display = 'none'; // 初始时隐藏
  
  // 创建播放/暂停按钮
  const playButton = document.createElement('button');
  playButton.id = 'segment-play-button';
  playButton.className = 'play-button';
  playButton.textContent = '播放';
  playButton.addEventListener('click', togglePlaySegments);
  
  // 创建速度控制
  const speedControl = document.createElement('div');
  speedControl.className = 'speed-control';
  
  const speedLabel = document.createElement('span');
  speedLabel.className = 'speed-label';
  speedLabel.textContent = '速度:';
  
  const speedSlider = document.createElement('input');
  speedSlider.type = 'range';
  speedSlider.id = 'segment-speed-slider';
  speedSlider.className = 'speed-slider';
  speedSlider.min = '1';
  speedSlider.max = '10';
  speedSlider.value = '3';
  speedSlider.addEventListener('input', updatePlaybackSpeed);
  speedSlider.addEventListener('change', updatePlaybackSpeed);
  
  const speedValue = document.createElement('span');
  speedValue.id = 'segment-speed-value';
  speedValue.className = 'speed-value';
  speedValue.textContent = '3x';
  
  // 组装速度控制
  speedControl.appendChild(speedLabel);
  speedControl.appendChild(speedSlider);
  speedControl.appendChild(speedValue);
  
  // 添加播放按钮和速度控制到播放控制区
  playerControls.appendChild(playButton);
  playerControls.appendChild(speedControl);
  
  // 添加按钮到视图切换组
  viewButtons.appendChild(viewOriginalBtn);
  viewButtons.appendChild(viewSegmentBtn);
  
  // 将播放控制添加到顶栏
  topBar.appendChild(playerControls);
  topBar.appendChild(viewButtons);
  topBar.appendChild(closeButton);
  
  // 创建内容区域
  const contentArea = document.createElement('div');
  contentArea.id = 'webpage-extractor-content';
  
  // 创建加载指示器
  const loadingElement = document.createElement('div');
  loadingElement.id = 'webpage-extractor-loading';
  loadingElement.textContent = '正在分词中...';
  loadingElement.style.display = 'none';
  
  // 创建原文内容容器
  const contentText = document.createElement('div');
  contentText.id = 'webpage-extractor-text';
  
  // 构建包含文本和图片的混合内容
  buildContentWithImages(contentText, contentData);
  contentText.style.display = 'block';
  
  // 创建分词结果区域
  const segmentResult = document.createElement('div');
  segmentResult.id = 'webpage-extractor-segment-result';
  segmentResult.style.display = 'none';
  segmentResult.setAttribute('data-has-images', contentData.images && contentData.images.length > 0 ? 'true' : 'false');
  
  // 组装内容
  contentArea.appendChild(loadingElement);
  contentArea.appendChild(contentText);
  contentArea.appendChild(segmentResult);
  overlay.appendChild(topBar);
  overlay.appendChild(contentArea);
  
  // 添加到页面
  document.body.appendChild(overlay);
  
  // 防止页面滚动
  document.body.style.overflow = 'hidden';
  
  // 确保初始视图是原文
  contentText.style.display = 'block';
  segmentResult.style.display = 'none';
  viewOriginalBtn.classList.add('active');
  viewSegmentBtn.classList.remove('active');
  
  // 确保播放控制区域初始隐藏
  if (playerControls) {
    playerControls.style.display = 'none';
  }
  
  // 存储原始内容数据，以便后续使用
  window.extractedContentData = contentData;
}

// 更新速度值显示
function updatePlaybackSpeed() {
  const slider = document.getElementById('segment-speed-slider');
  const value = document.getElementById('segment-speed-value');
  if (slider && value) {
    value.textContent = slider.value + 'x';
    
    // 更新播放器速度设置
    window.segmentPlayer = window.segmentPlayer || {};
    window.segmentPlayer.speed = parseInt(slider.value);
    
    // 如果正在播放，实时更新播放间隔
    if (window.segmentPlayer.isPlaying && segmentPlayInterval) {
      // 清除当前间隔
      clearInterval(segmentPlayInterval);
      
      // 使用新速度重新设置间隔
      segmentPlayInterval = setInterval(playNextSegment, 1000 / window.segmentPlayer.speed);
      
      console.log('播放速度已更新为:', window.segmentPlayer.speed + 'x');
    }
  }
}

// 移除遮罩层
function removeOverlay() {
  const overlay = document.getElementById('webpage-extractor-overlay');
  if (overlay) {
    // 停止播放
    if (window.segmentPlayer && window.segmentPlayer.isPlaying) {
      togglePlaySegments();
    }
    
    overlay.remove();
    // 恢复页面滚动
    document.body.style.overflow = '';
  }
}

// 提取元素中的文本和图片
function extractTextAndImages(element, imagesList) {
  // 保存元素的类型和排版信息
  const contentBlocks = [];
  
  // 识别有效的标题和内容元素，保持原始排版
  const contentElements = element.querySelectorAll('h1, h2, h3, h4, h5, h6, p, blockquote, pre, ul, ol, li');
  
  // 判断是否找到足够的内容元素
  if (contentElements.length >= 3) {
    let currentList = null;
    
    // 首先检查元素本身是否有开头图片
    const topImages = element.querySelectorAll(':scope > img, :scope > figure img');
    if (topImages.length > 0 && !imagesList.some(img => img.position === -1)) {
      // 使用第一张图片作为头图
      const headerImg = topImages[0];
      imagesList.push({
        src: headerImg.src,
        alt: headerImg.alt || '',
        position: -1  // 特殊标记为头图
      });
    }
    
    // 处理内容元素
    contentElements.forEach((elem) => {
      const tagName = elem.tagName.toLowerCase();
      const text = elem.innerText.trim();
      
      // 忽略空元素
      if (!text) return;
      
      // 处理列表元素
      if (tagName === 'ul' || tagName === 'ol') {
        currentList = {
          type: tagName,
          items: []
        };
        return;
      }
      
      // 处理列表项
      if (tagName === 'li') {
        // 判断是否为直接子列表项，避免嵌套列表重复提取
        const parentTagName = elem.parentElement.tagName.toLowerCase();
        if (parentTagName === 'ul' || parentTagName === 'ol') {
          if (currentList) {
            currentList.items.push(text);
          }
        }
        return;
      }
      
      // 如果有未处理的列表，添加到内容块
      if (currentList && currentList.items.length > 0) {
        contentBlocks.push({
          type: currentList.type,
          content: currentList.items
        });
        currentList = null;
      }
      
      // 处理标题和段落
      contentBlocks.push({
        type: tagName,
        content: text
      });
      
      // 检查后面是否紧跟着图片
      let nextElem = elem.nextElementSibling;
      while (nextElem && (nextElem.tagName === 'IMG' || 
                         nextElem.tagName === 'FIGURE' ||
                         (nextElem.querySelector && nextElem.querySelector('img')))) {
        // 提取图片
        const imgElement = nextElem.tagName === 'IMG' ? 
                         nextElem : 
                         (nextElem.tagName === 'FIGURE' ? 
                         nextElem.querySelector('img') : 
                         nextElem.querySelector('img'));
        
        if (imgElement && imgElement.src) {
          imagesList.push({
            src: imgElement.src,
            alt: imgElement.alt || '',
            position: contentBlocks.length - 1  // 关联到当前内容块
          });
        }
        
        nextElem = nextElem.nextElementSibling;
      }
    });
    
    // 处理剩余的列表
    if (currentList && currentList.items.length > 0) {
      contentBlocks.push({
        type: currentList.type,
        content: currentList.items
      });
    }
    
    // 将内容块转换为文本
    return contentBlocks.map(block => {
      if (block.type === 'ul' || block.type === 'ol') {
        // 为列表项添加标记
        const items = block.type === 'ul' 
          ? block.content.map(item => `• ${item}`)
          : block.content.map((item, i) => `${i+1}. ${item}`);
        return items.join('\n');
      } else {
        return block.content;
      }
    }).join('\n');
  } else {
    // 回退到简单的递归遍历
    const paragraphs = [];
    let inBlock = false;
    let currentBlock = '';
    
    // 递归遍历节点
    const walkNodes = (node, depth = 0) => {
      // 检查是否是图片元素
      if (node.nodeType === Node.ELEMENT_NODE) {
        const tagName = node.tagName.toLowerCase();
        
        // 如果是顶层图片且在文档开头，将其作为头图处理
        if (depth <= 2 && (tagName === 'img' || tagName === 'figure')) {
          const imgElement = tagName === 'img' ? node : node.querySelector('img');
          if (imgElement && imgElement.src && !imagesList.some(img => img.position === -1)) {
            // 检查图片大小
            if (isLargeEnoughForHeader(imgElement)) {
              imagesList.push({
                src: imgElement.src,
                alt: imgElement.alt || '',
                position: -1  // 特殊标记为头图
              });
              return;  // 处理完图片后直接返回
            }
          }
        }
        
        // 处理图片
        if (tagName === 'img' && node.src) {
          // 将图片添加到上一段末尾
          if (paragraphs.length > 0) {
            imagesList.push({
              src: node.src,
              alt: node.alt || '',
              position: paragraphs.length - 1
            });
          } else {
            // 如果还没有段落，作为头图
            imagesList.push({
              src: node.src,
              alt: node.alt || '',
              position: -1
            });
          }
          return;
        }
        
        // 处理figure中的图片
        if (tagName === 'figure') {
          const img = node.querySelector('img');
          if (img && img.src) {
            if (paragraphs.length > 0) {
              imagesList.push({
                src: img.src,
                alt: img.alt || '',
                position: paragraphs.length - 1
              });
            } else {
              imagesList.push({
                src: img.src,
                alt: img.alt || '',
                position: -1
              });
            }
          }
          return;
        }
        
        // 判断是否是块级元素
        const style = window.getComputedStyle(node);
        const isBlock = style.display === 'block' || 
                      tagName === 'div' || 
                      tagName === 'p' || 
                      tagName.match(/^h[1-6]$/) || 
                      tagName === 'section' ||
                      tagName === 'article';
                      
        // 列表处理
        if (tagName === 'ul' || tagName === 'ol') {
          const items = Array.from(node.querySelectorAll('li')).map(li => li.innerText.trim());
          if (items.length > 0) {
            // 根据列表类型添加项目标记
            const formattedItems = tagName === 'ul'
              ? items.map(item => `• ${item}`)
              : items.map((item, i) => `${i+1}. ${item}`);
            
            // 添加列表作为段落
            paragraphs.push(formattedItems.join('\n'));
          }
          return;
        }
        
        // 处理换行元素
        if (tagName === 'br') {
          if (currentBlock) {
            paragraphs.push(currentBlock.trim());
            currentBlock = '';
          }
          return;
        }
        
        // 开始新块
        if (isBlock && !inBlock) {
          inBlock = true;
          
          // 如果有未完成的块，添加它
          if (currentBlock.trim()) {
            paragraphs.push(currentBlock.trim());
            currentBlock = '';
          }
        }
        
        // 遍历子节点
        node.childNodes.forEach(child => walkNodes(child, depth + 1));
        
        // 结束块
        if (isBlock && inBlock) {
          inBlock = false;
          
          // 添加完成的块
          if (currentBlock.trim()) {
            paragraphs.push(currentBlock.trim());
            currentBlock = '';
          }
        }
      } else if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent.trim();
        if (text) {
          currentBlock += (currentBlock ? ' ' : '') + text;
        }
      }
    };
    
    // 开始遍历
    walkNodes(element);
    
    // 添加最后一个未处理的块
    if (currentBlock.trim()) {
      paragraphs.push(currentBlock.trim());
    }
    
    // 将段落连接为文本
    return paragraphs.join('\n');
  }
}

/**
 * 创建并添加自定义样式
 */
function createCustomStyles() {
  // 检查是否已添加样式
  if (document.getElementById('webpage-extractor-custom-styles')) {
    return;
  }
  
  const styleElement = document.createElement('style');
  styleElement.id = 'webpage-extractor-custom-styles';
  
  styleElement.textContent = `
    /* 主要容器样式 */
    .webpage-extractor-overlay {
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background-color: rgba(0, 0, 0, 0.75);
      z-index: 99999;
      display: flex;
      justify-content: center;
      align-items: center;
      font-family: "PingFang SC", "Microsoft YaHei", sans-serif;
    }
    
    .webpage-extractor-container {
      width: 90%;
      height: 90%;
      background-color: #fff;
      border-radius: 8px;
      display: flex;
      flex-direction: column;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
    }
    
    /* 头部样式 */
    .webpage-extractor-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 16px;
      border-bottom: 1px solid #eee;
      background-color: #f8f9fa;
      border-radius: 8px 8px 0 0;
    }
    
    .webpage-extractor-title {
      font-size: 18px;
      font-weight: bold;
      color: #333;
    }
    
    /* 按钮样式 */
    .webpage-extractor-btn {
      padding: 6px 12px;
      margin: 0 4px;
      border: 1px solid #ddd;
      border-radius: 4px;
      background-color: white;
      cursor: pointer;
      font-size: 14px;
      transition: all 0.2s ease;
    }
    
    .webpage-extractor-btn:hover {
      background-color: #f0f0f0;
    }
    
    .webpage-extractor-btn.primary {
      background-color: #4285f4;
      color: white;
      border-color: #4285f4;
    }
    
    .webpage-extractor-btn.primary:hover {
      background-color: #3367d6;
    }
    
    .webpage-extractor-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    
    /* 内容区域样式 */
    .webpage-extractor-content {
      flex: 1;
      display: flex;
      overflow: hidden;
    }
    
    .webpage-extractor-section {
      flex: 1;
      padding: 16px;
      overflow-y: auto;
      border-right: 1px solid #eee;
    }
    
    .webpage-extractor-section:last-child {
      border-right: none;
    }
    
    /* 分词结果样式 */
    .segment-content {
      line-height: 1.8;
      padding: 12px;
    }
    
    /* 段落样式 - 移除边框和背景色 */
    .segment-paragraph {
      margin-bottom: 1em;
      padding: 0.5em 0;
    }
    
    /* 去掉交替背景色和边框 */
    .segment-paragraph:nth-child(odd),
    .segment-paragraph:nth-child(even) {
      background-color: transparent;
      border: none;
    }
    
    /* 移除段落编号指示器 */
    .segment-paragraph::before {
      display: none;
    }
    
    /* 分词项样式 */
    .segment-item {
      display: inline-block;
      margin: 0 1px;
      padding: 0 1px;
      border-radius: 2px;
      cursor: pointer;
      transition: all 0.2s ease;
      color: #333;
    }
    
    .segment-item:hover {
      background-color: rgba(66, 133, 244, 0.1);
    }
    
    .segment-item.active {
      background-color: rgba(66, 133, 244, 0.2);
      color:rgb(48, 48, 48);
    }
    
    /* 分段信息提示 
    .segment-info {
      padding: 8px 16px;
      background-color: #f0f7ff;
      border-radius: 4px;
      margin-bottom: 12px;
      font-size: 14px;
      color: #333;
      border-left: 4px solid #4285f4;
    }
    */  
    
    /* 图片样式 */
    .extracted-image-container {
      margin: 15px 0;
      text-align: center;
    }

    .extracted-image {
      max-width: 100%;
      height: auto;
      border-radius: 5px;
      box-shadow: 0 2px 5px rgba(0, 0, 0, 0.1);
    }

    .extracted-image-header {
      max-width: 100%;
      height: auto;
      border-radius: 5px;
      box-shadow: 0 2px 5px rgba(0, 0, 0, 0.1);
      margin-bottom: 20px;
    }
    
    /* 加载状态 */
    .loading-indicator {
      display: inline-block;
      width: 16px;
      height: 16px;
      border: 2px solid rgba(66, 133, 244, 0.3);
      border-radius: 50%;
      border-top-color: #4285f4;
      animation: spin 1s ease-in-out infinite;
      margin-right: 8px;
      vertical-align: middle;
    }
    
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
  `;
  
  document.head.appendChild(styleElement);
} 