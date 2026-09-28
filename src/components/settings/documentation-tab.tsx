import { useState } from "react";
import { Download, FileText, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import {
  DOC_SECTIONS,
  DOC_TITLE,
  DOC_SUBTITLE,
  DOC_VERSION,
  DOC_DATE,
  DOC_NOTE,
  type DocSection,
  type DocBlock,
} from "./documentation-content";

export function DocumentationTab() {
  const [downloading, setDownloading] = useState(false);

  async function handleDownload() {
    setDownloading(true);
    try {
      const [{ default: jsPDF }, autoTableMod] = await Promise.all([
        import("jspdf"),
        import("jspdf-autotable"),
      ]);
      const autoTable = ((autoTableMod as Record<string, unknown>).default ?? autoTableMod) as (
        ...args: unknown[]
      ) => void;

      const doc = new jsPDF({ unit: "pt", format: "letter" });
      const pageWidth = doc.internal.pageSize.getWidth();
      const pageHeight = doc.internal.pageSize.getHeight();
      const margin = 54;
      const contentWidth = pageWidth - margin * 2;
      const brand: [number, number, number] = [37, 99, 235]; // blue-600
      const muted: [number, number, number] = [107, 114, 128];
      const text: [number, number, number] = [17, 24, 39];

      // ---------- Title page ----------
      doc.setFillColor(...brand);
      doc.rect(0, 0, pageWidth, 180, "F");
      doc.setTextColor(255, 255, 255);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(11);
      doc.text("LEAD FLOW CRM", margin, 60);
      doc.setFontSize(24);
      doc.text("Complete System", margin, 110);
      doc.text("Documentation", margin, 140);

      doc.setTextColor(...text);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(11);
      doc.text(`Version ${DOC_VERSION}`, margin, 230);
      doc.text(`Generated: ${DOC_DATE}`, margin, 250);
      doc.setTextColor(...muted);
      const subLines = doc.splitTextToSize(
        "Full reference for roles, leads, workflows, permissions, notifications, integrations, and technical architecture.",
        contentWidth,
      );
      doc.text(subLines, margin, 290);

      doc.setFontSize(9);
      doc.setTextColor(...muted);
      const noteLines = doc.splitTextToSize(DOC_NOTE, contentWidth);
      doc.text(noteLines, margin, pageHeight - margin - noteLines.length * 12);

      // ---------- Table of contents ----------
      doc.addPage();
      let y = margin;
      doc.setTextColor(...text);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(18);
      doc.text("Table of Contents", margin, y);
      y += 24;
      doc.setFontSize(10);
      doc.setFont("helvetica", "normal");
      for (const s of DOC_SECTIONS) {
        if (y > pageHeight - margin - 20) {
          doc.addPage();
          y = margin;
        }
        const label = `${s.number}. ${s.title}`;
        doc.setTextColor(...text);
        doc.text(label, margin, y);
        y += 16;
      }

      // ---------- Sections ----------
      const renderSection = (section: DocSection) => {
        doc.addPage();
        y = margin;
        doc.setTextColor(...brand);
        doc.setFont("helvetica", "bold");
        doc.setFontSize(14);
        doc.text(`${section.number}. ${section.title}`, margin, y);
        y += 22;
        doc.setTextColor(...text);

        const ensureSpace = (h: number) => {
          if (y + h > pageHeight - margin - 20) {
            doc.addPage();
            y = margin;
          }
        };

        for (const block of section.blocks) {
          renderBlock(block, section);
        }

        function renderBlock(block: DocBlock, sec: DocSection) {
          if (block.kind === "p") {
            doc.setFont("helvetica", "normal");
            doc.setFontSize(10.5);
            const lines = doc.splitTextToSize(block.text, contentWidth);
            ensureSpace(lines.length * 14 + 6);
            doc.text(lines, margin, y);
            y += lines.length * 14 + 8;
          } else if (block.kind === "h3") {
            doc.setFont("helvetica", "bold");
            doc.setFontSize(11.5);
            ensureSpace(22);
            doc.text(block.text, margin, y);
            y += 18;
          } else if (block.kind === "ul") {
            doc.setFont("helvetica", "normal");
            doc.setFontSize(10.5);
            for (const item of block.items) {
              const lines = doc.splitTextToSize(item, contentWidth - 14);
              ensureSpace(lines.length * 14 + 4);
              doc.text("•", margin, y);
              doc.text(lines, margin + 14, y);
              y += lines.length * 14 + 2;
            }
            y += 6;
          } else if (block.kind === "table") {
            autoTable(doc, {
              startY: y,
              head: [block.headers],
              body: block.rows,
              margin: { left: margin, right: margin },
              styles: { fontSize: 9, cellPadding: 6, overflow: "linebreak", valign: "top" },
              headStyles: { fillColor: brand, textColor: 255, fontStyle: "bold" },
              alternateRowStyles: { fillColor: [245, 247, 250] },
              theme: "grid",
              didDrawPage: () => {
                // keep header spacing consistent on wrapped pages
              },
            });
            y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 14;
          }
          void sec;
        }
      };

      for (const section of DOC_SECTIONS) {
        renderSection(section);
      }

      // ---------- Page numbers & footer ----------
      const pageCount = doc.getNumberOfPages();
      for (let i = 1; i <= pageCount; i++) {
        doc.setPage(i);
        doc.setFont("helvetica", "normal");
        doc.setFontSize(8.5);
        doc.setTextColor(...muted);
        doc.text("JellyBean Documentation", margin, pageHeight - 24);
        doc.text(`Page ${i} of ${pageCount}`, pageWidth - margin, pageHeight - 24, {
          align: "right",
        });
      }

      doc.save("lead-flow-crm-complete-documentation.pdf");
    } catch (err) {
      console.error(err);
      toast.error("Failed to generate PDF");
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="crm-section-panel">
        <div className="crm-surface-card p-6 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-primary text-xs font-semibold uppercase tracking-[0.14em]">
              <FileText className="h-3.5 w-3.5" /> Documentation
            </div>
            <h2 className="mt-2 text-[22px] font-bold tracking-tight text-foreground">
              {DOC_TITLE}
            </h2>
            <p className="mt-2 text-sm text-muted-foreground max-w-3xl leading-relaxed">
              {DOC_SUBTITLE}
            </p>
          </div>
          <div className="shrink-0">
            <Button onClick={handleDownload} disabled={downloading} className="h-10 rounded-xl">
              {downloading ? (
                <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
              ) : (
                <Download className="h-4 w-4 mr-1.5" />
              )}
              Download PDF
            </Button>
          </div>
        </div>
      </div>

      <nav className="crm-section-panel">
        <div className="crm-surface-card p-5">
          <h3 className="text-sm font-semibold mb-3">Table of contents</h3>
          <ol className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-1.5 text-[13px]">
            {DOC_SECTIONS.map((s) => (
              <li key={s.id}>
                <a
                  href={`#doc-${s.id}`}
                  className="text-muted-foreground hover:text-primary crm-motion"
                >
                  <span className="font-mono text-[11px] mr-2 text-primary/70">
                    {String(s.number).padStart(2, "0")}
                  </span>
                  {s.title}
                </a>
              </li>
            ))}
          </ol>
        </div>
      </nav>

      <div className="space-y-5">
        {DOC_SECTIONS.map((section) => (
          <section
            key={section.id}
            id={`doc-${section.id}`}
            className="crm-section-panel scroll-mt-24"
          >
            <div className="crm-surface-card p-6">
              <div className="flex items-baseline gap-3 mb-4">
                <span className="text-[11px] font-mono font-semibold text-primary bg-primary/10 rounded-md px-2 py-0.5">
                  {String(section.number).padStart(2, "0")}
                </span>
                <h3 className="text-[17px] font-bold tracking-tight text-foreground">
                  {section.title}
                </h3>
              </div>
              <div className="space-y-3 text-[13.5px] leading-relaxed text-foreground/90">
                {section.blocks.map((block, i) => (
                  <BlockView key={i} block={block} />
                ))}
              </div>
            </div>
          </section>
        ))}
      </div>

      <p className="text-xs text-muted-foreground italic px-1">{DOC_NOTE}</p>
    </div>
  );
}

function BlockView({ block }: { block: DocBlock }) {
  if (block.kind === "p") {
    return <p className="text-muted-foreground">{block.text}</p>;
  }
  if (block.kind === "h3") {
    return <h4 className="text-[14px] font-semibold text-foreground pt-1">{block.text}</h4>;
  }
  if (block.kind === "ul") {
    return (
      <ul className="list-disc pl-5 space-y-1.5 text-muted-foreground marker:text-primary/60">
        {block.items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    );
  }
  if (block.kind === "table") {
    return (
      <div className="overflow-x-auto rounded-xl border border-border/60 mt-1">
        <table className="w-full text-[12.5px]">
          <thead className="bg-primary/8">
            <tr>
              {block.headers.map((h, i) => (
                <th
                  key={i}
                  className="text-left px-3 py-2 font-semibold text-foreground/80 border-b border-border/60 whitespace-nowrap"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, ri) => (
              <tr key={ri} className="border-b border-border/40 last:border-0 odd:bg-muted/20">
                {row.map((cell, ci) => (
                  <td key={ci} className="px-3 py-2 text-muted-foreground align-top">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return null;
}
