import { useEffect, useState } from "react";
import { useTranslate } from "react-admin";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import CircularProgress from "@mui/material/CircularProgress";
import Typography from "@mui/material/Typography";
import Link from "@mui/material/Link";
import Divider from "@mui/material/Divider";
import Table from "@mui/material/Table";
import TableHead from "@mui/material/TableHead";
import TableBody from "@mui/material/TableBody";
import TableRow from "@mui/material/TableRow";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import Paper from "@mui/material/Paper";
import MenuBookIcon from "@mui/icons-material/MenuBook";
import CloseIcon from "@mui/icons-material/Close";
import DownloadIcon from "@mui/icons-material/Download";

const PDF_URL = "/naming-conventions.pdf";
const MD_URL = "/naming-conventions.md";

const MONO = "'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace";

/**
 * Map the guide's Markdown onto MUI primitives styled to the admin theme
 * (indigo primary). Each mapper destructures only the props it uses so
 * react-markdown's internal `node` prop is never spread onto a DOM element.
 */
const markdownComponents: Components = {
  h1: ({ children }) => (
    <Typography variant="h5" sx={{ color: "primary.dark", fontWeight: 700, mb: 1 }}>
      {children}
    </Typography>
  ),
  h2: ({ children }) => (
    <Typography
      variant="h6"
      sx={{
        color: "primary.dark",
        fontWeight: 700,
        mt: 3.5,
        mb: 1,
        pb: 0.5,
        borderBottom: "1px solid",
        borderColor: "divider",
      }}
    >
      {children}
    </Typography>
  ),
  h3: ({ children }) => (
    <Typography variant="subtitle1" sx={{ fontWeight: 700, color: "text.primary", mt: 2.5, mb: 0.75 }}>
      {children}
    </Typography>
  ),
  p: ({ children }) => (
    <Typography variant="body2" sx={{ fontSize: "0.9rem", lineHeight: 1.7, mb: 1.5, color: "text.primary" }}>
      {children}
    </Typography>
  ),
  a: ({ href, children }) => (
    <Link href={href} target="_blank" rel="noopener noreferrer" sx={{ color: "primary.main", fontWeight: 600 }}>
      {children}
    </Link>
  ),
  ul: ({ children }) => <Box component="ul" sx={{ pl: 3, mt: 0.5, mb: 1.5 }}>{children}</Box>,
  ol: ({ children }) => <Box component="ol" sx={{ pl: 3, mt: 0.5, mb: 1.5 }}>{children}</Box>,
  li: ({ children }) => (
    <Box component="li" sx={{ mb: 0.75, lineHeight: 1.7, fontSize: "0.9rem", color: "text.primary" }}>
      {children}
    </Box>
  ),
  strong: ({ children }) => <Box component="strong" sx={{ fontWeight: 700 }}>{children}</Box>,
  em: ({ children }) => <Box component="em" sx={{ fontStyle: "italic" }}>{children}</Box>,
  blockquote: ({ children }) => (
    <Box
      sx={{
        borderLeft: "3px solid",
        borderColor: "primary.main",
        bgcolor: "rgba(91,94,166,0.06)",
        pl: 2,
        pr: 1.5,
        py: 0.5,
        my: 2,
        borderRadius: "0 8px 8px 0",
        "& p:last-child": { mb: 0 },
      }}
    >
      {children}
    </Box>
  ),
  hr: () => <Divider sx={{ my: 2 }} />,
  // Fenced blocks (multi-line) become a scrollable code panel; inline code (no
  // newline) becomes a small tinted chip. The guide never mixes the two.
  code: ({ children }) => {
    const text = String(children ?? "");
    if (text.includes("\n")) {
      return (
        <Box
          component="code"
          sx={{
            display: "block",
            whiteSpace: "pre",
            overflowX: "auto",
            fontFamily: MONO,
            fontSize: "0.8rem",
            lineHeight: 1.6,
            bgcolor: "rgba(0,0,0,0.03)",
            border: "1px solid",
            borderColor: "divider",
            borderRadius: 2,
            p: 2,
            my: 2,
            color: "text.primary",
          }}
        >
          {children}
        </Box>
      );
    }
    return (
      <Box
        component="code"
        sx={{
          fontFamily: MONO,
          fontSize: "0.85em",
          bgcolor: "rgba(91,94,166,0.1)",
          color: "primary.dark",
          px: 0.5,
          py: 0.1,
          borderRadius: 1,
        }}
      >
        {children}
      </Box>
    );
  },
  pre: ({ children }) => <>{children}</>,
  table: ({ children }) => (
    <TableContainer component={Paper} variant="outlined" sx={{ my: 2 }}>
      <Table size="small">{children}</Table>
    </TableContainer>
  ),
  thead: ({ children }) => <TableHead>{children}</TableHead>,
  tbody: ({ children }) => <TableBody>{children}</TableBody>,
  tr: ({ children }) => <TableRow>{children}</TableRow>,
  th: ({ children }) => <TableCell component="th" sx={{ fontWeight: 700 }}>{children}</TableCell>,
  td: ({ children }) => <TableCell>{children}</TableCell>,
};

export interface NamingConventionsDialogProps {
  open: boolean;
  onClose: () => void;
}

export function NamingConventionsDialog({ open, onClose }: NamingConventionsDialogProps) {
  const translate = useTranslate();
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState(false);

  // Fetch the served Markdown once, the first time the dialog opens. The dialog
  // title already names the guide, so drop the source's leading H1.
  useEffect(() => {
    if (!open || content !== null) return;
    let cancelled = false;
    fetch(MD_URL)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then((text) => {
        if (!cancelled) setContent(text.replace(/^#\s+.*\n+/, ""));
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open, content]);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth scroll="paper">
      <DialogTitle
        component="div"
        sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 2, pr: 1.5 }}
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <MenuBookIcon sx={{ color: "primary.main" }} />
          <Typography variant="h6" component="span" sx={{ fontWeight: 700 }}>
            {translate("padmakara.namingConventions.title") || "Naming conventions"}
          </Typography>
        </Box>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <Button
            component="a"
            href={PDF_URL}
            download
            target="_blank"
            rel="noopener noreferrer"
            size="small"
            variant="outlined"
            startIcon={<DownloadIcon />}
          >
            {translate("padmakara.namingConventions.downloadPdf") || "Download PDF"}
          </Button>
          <IconButton
            onClick={onClose}
            size="small"
            aria-label={translate("padmakara.namingConventions.close") || "Close"}
          >
            <CloseIcon />
          </IconButton>
        </Box>
      </DialogTitle>
      <DialogContent dividers sx={{ "& > :first-of-type": { mt: 0 } }}>
        {error ? (
          <Box sx={{ py: 4, textAlign: "center" }}>
            <Typography variant="body2" sx={{ color: "text.secondary", mb: 2 }}>
              {translate("padmakara.namingConventions.loadError") ||
                "Couldn't load the guide here. Download the PDF instead."}
            </Typography>
            <Button
              component="a"
              href={PDF_URL}
              download
              target="_blank"
              rel="noopener noreferrer"
              variant="contained"
              startIcon={<DownloadIcon />}
            >
              {translate("padmakara.namingConventions.downloadPdf") || "Download PDF"}
            </Button>
          </Box>
        ) : content === null ? (
          <Box sx={{ display: "flex", justifyContent: "center", py: 6 }}>
            <CircularProgress />
          </Box>
        ) : (
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
            {content}
          </ReactMarkdown>
        )}
      </DialogContent>
    </Dialog>
  );
}
