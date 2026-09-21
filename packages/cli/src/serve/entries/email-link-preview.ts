/** Local mail is surfaced outside the application; no app-specific sandbox imports. */
export function showEmailLinkPreview(mail: import("pyric/auth").OutboundAuthMail, completeInPage?: () => Promise<unknown>) {
    document.querySelector("[data-pyric-mail-preview]")?.remove();
    const dialog = document.createElement("dialog");
    dialog.setAttribute("data-pyric-mail-preview", "");
    dialog.setAttribute("aria-labelledby", "pyric-mail-title");
    dialog.style.cssText =
        "box-sizing:border-box;width:min(440px,calc(100vw - 32px));padding:28px;border:1px solid #424854;border-radius:16px;background:#1b1e25;color:#eef0f5;font:14px/1.6 system-ui;box-shadow:0 16px 60px #0006";
    const heading = document.createElement("h2");
    heading.id = "pyric-mail-title";
    heading.textContent = "Sign-in email";
    heading.style.cssText = "margin:0 0 12px;font-size:22px";
    const recipient = document.createElement("p");
    recipient.textContent = `To: ${mail.email}`;
    const explanation = document.createElement("p");
    explanation.textContent =
        "Pyric local email preview. No email was sent to an external inbox.";
    const link = document.createElement("a");
    link.textContent = "Open sign-in link";
    link.href = mail.link;
    link.target = "_blank";
    link.rel = "noopener";
    link.style.cssText =
        "display:block;background:#bed0ff;color:#152347;padding:12px 16px;border-radius:8px;text-align:center;font-weight:600;margin:20px 0;text-decoration:none";
    if (completeInPage)
        link.onclick = async (event) => {
            event.preventDefault();
            link.textContent = "Signing in…";
            try {
                await completeInPage();
                dialog.close();
            }
            catch {
                explanation.textContent =
                    "This sign-in link is no longer valid. Close this preview and request a new link.";
                link.remove();
            }
        };
    const close = document.createElement("button");
    close.textContent = "Close";
    close.style.cssText =
        "font:inherit;background:transparent;border:1px solid #718096;color:inherit;padding:8px 18px;border-radius:8px;cursor:pointer";
    close.onclick = () => dialog.close();
    dialog.onclose = () => dialog.remove();
    dialog.append(heading, recipient, explanation, link, close);
    document.body.append(dialog);
    dialog.showModal();
}
