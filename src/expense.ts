import {
  ActionRowBuilder,
  Attachment,
  ButtonBuilder,
  ButtonStyle,
  Colors,
  EmbedBuilder,
  GuildMember,
  Interaction,
  Message,
  ModalBuilder,
  SlashCommandBuilder,
  TextBasedChannel,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { getExpenseByMessage, insertExpense, updateStatus } from './services/database';
import { appendExpense } from './services/sheets';
import { uploadReceipt } from './services/fileStorage';

export const expenseCommandData = new SlashCommandBuilder()
  .setName('request')
  .setDescription('経費申請フォームを開きます')
  .toJSON();

// 金額文字列を正規化する（全角→半角、通貨記号除去、カンマ整形）
function normalizeAmount(input: string): string {
  // 全角数字を半角に変換
  let s = input.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  // 数字以外（円、¥、￥、カンマ、スペース等）を除去
  s = s.replace(/[^\d]/g, '');
  const num = parseInt(s, 10);
  if (isNaN(num)) return input.trim(); // 数値として解釈できなければそのまま返す
  // カンマ区切りにフォーマット
  return num.toLocaleString('ja-JP');
}

// YYYY/MM/DD HH:MM 形式でJST現在時刻を返す
function nowJst(): string {
  const now = new Date();
  const jst = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  const y = jst.getFullYear();
  const mo = String(jst.getMonth() + 1).padStart(2, '0');
  const d = String(jst.getDate()).padStart(2, '0');
  const h = String(jst.getHours()).padStart(2, '0');
  const mi = String(jst.getMinutes()).padStart(2, '0');
  return `${y}/${mo}/${d} ${h}:${mi}`;
}

type Status = '審査中' | '承認済み' | '却下';

const COLOR_MAP: Record<Status, number> = {
  '審査中': Colors.Yellow,
  '承認済み': Colors.Green,
  '却下': Colors.Red,
};

function buildEmbed(
  applicant: string,
  amount: string,
  purpose: string,
  imageUrl: string | null,
  appliedAt: string,
  status: Status = '審査中',
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle('経費申請')
    .setColor(COLOR_MAP[status])
    .addFields(
      { name: '申請者', value: applicant, inline: true },
      { name: '金額', value: amount, inline: true },
      { name: 'ステータス', value: status, inline: true },
      { name: '用途・目的', value: purpose },
    )
    .setFooter({ text: `申請日時: ${appliedAt}` });

  if (imageUrl) {
    embed.addFields({ name: '領収書', value: imageUrl });
  }

  return embed;
}

function buildButtons(disabled = false): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('expense:approve')
      .setLabel('承認')
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId('expense:reject')
      .setLabel('却下')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
  );
}

/** 領収書ファイルの添付を待ち、Attachment を返す。タイムアウト or スキップは null。 */
async function collectReceiptAttachment(
  interaction: Interaction & { channel: NonNullable<Interaction['channel']> },
): Promise<Attachment | null> {
  const TIMEOUT_MS = 60_000;

  if (!interaction.isModalSubmit()) return null;
  await interaction.reply({
    content: [
      '領収書ファイル（画像・PDF）をこのチャンネルに添付してください。',
      'スキップする場合は `skip` と送信してください。',
      `⏱ ${TIMEOUT_MS / 1000}秒以内に送信してください。`,
    ].join('\n'),
    ephemeral: true,
  });

  // PartialGroupDMChannel は awaitMessages を持たないので除外
  const channel = interaction.channel as TextBasedChannel;
  if (!('awaitMessages' in channel)) return null;

  try {
    const collected = await channel.awaitMessages({
      filter: (m: Message) => m.author.id === interaction.user.id,
      max: 1,
      time: TIMEOUT_MS,
      errors: ['time'],
    });

    const msg = collected.first()!;
    await msg.delete().catch(() => {});

    if (msg.content.trim().toLowerCase() === 'skip') return null;

    const attachment = msg.attachments.first();
    if (!attachment) return null;

    // 画像または PDF のみ受け付ける
    const ct = attachment.contentType ?? '';
    if (!ct.startsWith('image/') && ct !== 'application/pdf') {
      await interaction.followUp({
        content: '画像またはPDFファイルのみ添付できます。領収書なしで申請を続行します。',
        ephemeral: true,
      });
      return null;
    }

    return attachment;
  } catch {
    return null;
  }
}

export async function handleInteraction(interaction: Interaction): Promise<void> {
  // ── /request スラッシュコマンド ─────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'request') {
    const modal = new ModalBuilder()
      .setCustomId('expense_modal')
      .setTitle('経費申請フォーム')
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('amount')
            .setLabel('金額')
            .setPlaceholder('例: 3,000円')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(50),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('purpose')
            .setLabel('用途・目的')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(500),
        ),
      );

    await interaction.showModal(modal);
    return;
  }

  // ── モーダル送信 ────────────────────────────────────────────────────────
  if (interaction.isModalSubmit() && interaction.customId === 'expense_modal') {
    const channel = interaction.channel;
    if (!channel) return;

    const applicant = interaction.user.tag;
    const amount = normalizeAmount(interaction.fields.getTextInputValue('amount'));
    const purpose = interaction.fields.getTextInputValue('purpose').trim();
    const appliedAt = nowJst();

    // 領収書ファイルを収集（内部で ephemeral reply 済み）
    const attachment = await collectReceiptAttachment(
      interaction as Interaction & { channel: NonNullable<Interaction['channel']> },
    );

    // files.c-lab.works にアップロード
    let imageUrl: string | null = null;
    let viewUrl: string | null = null;
    if (attachment) {
      try {
        imageUrl = await uploadReceipt(
          attachment.url,
          attachment.name,
          attachment.contentType ?? 'application/octet-stream',
          `経費申請 ${appliedAt} by ${applicant}`,
        );
        viewUrl = `https://files.c-lab.works/view/${attachment.name}?key=c-lab`;
      } catch (err) {
        console.error('領収書アップロード失敗:', err);
        await interaction.followUp({
          content: '領収書のアップロードに失敗しました。領収書なしで申請を続行します。',
          ephemeral: true,
        });
      }
    }

    // followUp で申請Embedをチャンネルに投稿（全員に見える）
    const expenseMsg = await interaction.followUp({
      embeds: [buildEmbed(applicant, amount, purpose, viewUrl, appliedAt)],
      components: [buildButtons()],
    });

    insertExpense({
      message_id: expenseMsg.id,
      channel_id: channel.id,
      applicant,
      amount,
      purpose,
      image_url: viewUrl,
      applied_at: appliedAt,
    });

    return;
  }

  // ── 承認 / 却下ボタン ───────────────────────────────────────────────────
  if (
    interaction.isButton() &&
    (interaction.customId === 'expense:approve' || interaction.customId === 'expense:reject')
  ) {
    const approvalRoleId = process.env.APPROVAL_ROLE_ID;
    if (approvalRoleId) {
      const member = interaction.member;
      // GuildMember（キャッシュあり）と APIInteractionGuildMember（キャッシュなし）の両方に対応
      const hasRole = member instanceof GuildMember
        ? member.roles.cache.has(approvalRoleId)
        : Array.isArray(member?.roles) && (member.roles as string[]).includes(approvalRoleId);
      if (!hasRole) {
        await interaction.reply({ content: '承認権限がありません。', ephemeral: true });
        return;
      }
    }

    const messageId = interaction.message.id;
    const record = getExpenseByMessage(messageId);

    if (!record) {
      await interaction.reply({ content: '申請データが見つかりません。', ephemeral: true });
      return;
    }

    if (record.status !== '審査中') {
      await interaction.reply({
        content: `この申請はすでに「${record.status}」です。`,
        ephemeral: true,
      });
      return;
    }

    const approved = interaction.customId === 'expense:approve';
    const newStatus: Status = approved ? '承認済み' : '却下';
    let sheetRow: number | undefined;

    if (approved) {
      sheetRow = await appendExpense({
        applied_at: record.applied_at,
        applicant: record.applicant,
        amount: record.amount,
        purpose: record.purpose,
        image_url: record.image_url,
        approver: interaction.user.tag,
        approved_at: nowJst(),
      });
    }

    updateStatus(messageId, newStatus, sheetRow);

    await interaction.update({
      embeds: [
        buildEmbed(
          record.applicant,
          record.amount,
          record.purpose,
          record.image_url,
          record.applied_at,
          newStatus,
        ),
      ],
      components: [buildButtons(true)],
    });

    return;
  }
}
